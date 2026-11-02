// src/store.mjs —— 插件自己的缓存。三条规矩，缺一条就会出事
//
// 规矩 ①：**只写 `~/.cache/magpie`，不碰 `~/.config/magpie`。**
//   后者是 magpie 的目录（plugins.json / plugin-auth.json / 插件市场的那份缓存…）。
//   插件对那里只有读的份 —— 写它等于改别人的状态，历史上真的把 registry 条目盖掉过。
//
// 规矩 ②：**文件名里必须带「谁的数据」。** 宿主是同一个进程跑所有账号，
//   用模块级变量或单文件存 per-account 状态，第二个账号进来就会串号。
//   约定：`<plugin>-<kind>-<siteId>.json`，按账号的再加 `__<account>`：
//     plugin-store-snapshot-magicrew.json          ← 整站共享（模型目录）
//     plugin-store-session-magicrew.json           ← 当前登录态（每站点一条）
//     plugin-store-key-magicrew__h97gkbu8bruj.json ← 每账号一条（key / 标记）
//
// 规矩 ③：**这里的东西全都可删。** 删掉整个目录，插件应该只是「重新登录一次 +
//   重新拉一遍模型」，而不是崩。所以：读失败一律当「没有」，不要抛。
//
// ⚠ 不要在这里存 token 的明文副本。要存就存 magpie 给的那份的引用（`auth.*`），
//   或者只存「是否已失效」这类派生事实。

import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** 插件前缀 —— 派生仓库改成自己的包名短名，避免和别人撞文件 */
const PREFIX = "plugin-store"

function cacheDir() {
  return join(homedir(), ".cache", "magpie")
}

/**
 * 文件名拼装。`siteId` 用于「一个包两个供应商」的情形（`cn` / `intl`）；
 * `account` 传了就按账号隔离 —— **凡是每账号不同的数据都必须传它**。
 */
export function fileOf(kind, { siteId, account } = {}) {
  const parts = [PREFIX, kind]
  if (siteId) parts.push(String(siteId))
  const name = parts.join("-") + (account ? `__${String(account)}` : "") + ".json"
  return join(cacheDir(), name)
}

/** 读 JSON。文件不在、内容坏了、权限不对 —— 一律返回 fallback，不抛。 */
export function readJson(file, fallback = null) {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"))
    return v ?? fallback
  } catch {
    return fallback
  }
}

/**
 * 原子写。**必须走这条** —— 直接 `writeFileSync` 写到一半被关机，
 * 下次启动读到半截 JSON，`JSON.parse` 抛错，然后整个钩子炸掉。
 * 先写 `.tmp` 再 `rename`，rename 在同一分区上是原子的。
 */
export function writeJson(file, value) {
  try {
    mkdirSync(cacheDir(), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(value))
    renameSync(tmp, file)
    return true
  } catch {
    return false // 缓存写不进去不该影响主流程
  }
}

/** 删一个文件（清理 / 重置用）。不存在也算成功。 */
export function removeJson(file) {
  try {
    rmSync(file, { force: true })
    return true
  } catch {
    return false
  }
}

// ── 三个具体用途，照抄成自己的 ──────────────────────────────────────
//
// 这三段是四个真实插件里反复出现的三种数据。名字随便改，形状别改。

/**
 * ① 模型目录快照 —— **上游拿不到时的兜底**。
 *
 * 为什么要有：`provider.models` 抛异常，整张卡片会从列表里消失。
 * 正确做法是退回上次的快照（哪怕是旧的），而不是返回空表或抛错。
 * 这也是「部分成功三态」的第一态（见 src/models.mjs）。
 */
export function readSnapshot(siteId) {
  return readJson(fileOf("snapshot", { siteId }), null)
}
export function writeSnapshot(siteId, models) {
  // 只存条目本身，不要存 token / 时间戳以外的东西
  return writeJson(fileOf("snapshot", { siteId }), { at: new Date().toISOString(), models })
}

/**
 * ② 登录态 —— 插件自己记住「上次是谁」用。
 *
 * ⚠ 不要把 magpie 给的 `auth` 原样抄一份存这里。那份凭据由 magpie 管，
 *   抄一份就会有两个人同时刷新 token，最后分叉、用户莫名掉登录。
 *   这里只该存**派生事实**：账号 id、上次登录时间、是否需要重新登录。
 */
export function readSession(siteId) {
  return readJson(fileOf("session", { siteId }), null)
}
export function writeSession(siteId, { accountId, org } = {}) {
  return writeJson(fileOf("session", { siteId }), { at: new Date().toISOString(), accountId, org })
}

/**
 * ③ 每账号的一次性标记 —— 最容易写错的一种。
 *
 * 判据：「这件事每个账号一辈子只做一次吗？」
 *   是 → 落**永久标记**（`{ at, status }`），做完就永不重做，换天/重登/重启都一样
 *   否（每天一次）→ 落**日期**，但日期要按**厂商所在时区**算，不是本机时区
 *
 * ⚠ 失败方向要选对：真发出去失败了才计数并重试（上限 3 次）；
 *   「还没条件做」（比如还没工作区、接口暂时查不到）**不算失败、不计数、不落标记**，
 *   下次再来 —— 否则一个暂时条件会把这件事永久钉死。
 */
export function readOnce(siteId, account, kind = "once") {
  return readJson(fileOf(kind, { siteId, account }), null)
}
export function markOnce(siteId, account, entry = {}, kind = "once") {
  return writeJson(fileOf(kind, { siteId, account }), { at: new Date().toISOString(), ...entry })
}
export function isSettled(siteId, account, kind = "once") {
  const v = readOnce(siteId, account, kind)
  return v?.status === "done" || v?.status === "sent" || v?.status === "gave-up"
}

/**
 * 清理：把某个 kind 下超过 keep 条的旧文件删掉。
 *
 * 为什么要：有的插件按日期落一堆文件（`...-2026-10-28.json`），
 * 一年就是 365 个。留个上限，别把用户的家目录当数据库。
 */
export function prune(kind, keep = 30) {
  try {
    const dir = cacheDir()
    const all = readdirSync(dir)
      .filter((f) => f.startsWith(`${PREFIX}-${kind}`) && f.endsWith(".json"))
      .sort() // 文件名里带日期时，字典序即时间序
    const excess = all.slice(0, Math.max(0, all.length - keep))
    for (const f of excess) rmSync(join(dir, f), { force: true })
    return excess.length
  } catch {
    return 0
  }
}
