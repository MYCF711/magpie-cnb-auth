// src/local-token.mjs —— 读本机 cnb-cli 的登录态
//
// 这是「不弹浏览器」的那条登录路：用户装过 cnb-cli 并且 `cnb login` 过，令牌就在盘上。
//
// ⚠ 只能读到**那一个**账号。`~/.cnb/token` 只由终端的 `cnb login` 写，
//   在浏览器里换账号**不会**更新它 —— 所以「加第二个账号」不能用这条路，
//   要用设备码授权（src/device.mjs 全程不碰这个文件）。

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { OAUTH_CLIENT_ID } from "./context.mjs"

/**
 * cnb-cli 写出来的 `~/.cnb/token` 实测结构（别想当然）：
 *
 *   {
 *     "auths": {
 *       "cnb.cool": {
 *         "access_token": "…",      // 94 字符左右，有效期约 8 小时
 *         "refresh_token": "…",
 *         "expires_at": 1792419526, // 秒
 *         "client_id": "cnb_cli",
 *         "login_host": "https://api.cnb.cool",
 *         "platform_url": "https://cnb.cool",
 *         "scope": "…"
 *       }
 *     }
 *   }
 *
 * 早期版本只看顶层 `access_token` 会读成空串 —— 这就是「网页都登录了插件却读不到」的原因。
 */
function pickAuthEntry(json) {
  const auths = json?.auths
  if (auths && typeof auths === "object") {
    const direct = auths["cnb.cool"]
    if (direct && typeof direct === "object") return direct
    for (const value of Object.values(auths)) {
      if (value && typeof value === "object" && (value.access_token || value.token || value.access)) return value
    }
  }
  for (const key of ["cnb", "cnb.cool", "oauth", "token"]) {
    const value = json?.[key]
    if (value && typeof value === "object" && (value.access_token || value.token || value.access)) return value
  }
  return null
}

/** 过期时间统一成毫秒。cnb-cli 写秒，别的实现可能写毫秒。 */
export function normalizeExpiry(value) {
  const n = Number(value) || 0
  if (!n) return 0
  return n < 1e12 ? n * 1000 : n
}

/** 解析 token 文件的正文。JSON 也认，裸串也认（cnb-cli 早期版本写的裸 token）。 */
export function parseTokenText(raw) {
  const text = String(raw || "").trim()
  if (!text) return null
  try {
    const json = JSON.parse(text)
    if (json && typeof json === "object") {
      const entry = pickAuthEntry(json) || json
      const access = entry.access_token || entry.access || entry.token || entry.key || ""
      return {
        token: String(access || ""),
        refresh: String(entry.refresh_token || entry.refresh || ""),
        expires: normalizeExpiry(entry.expires_at ?? entry.expires),
        clientId: String(entry.client_id || OAUTH_CLIENT_ID),
        accountId: String(entry.username || entry.login || json.username || ""),
        source: "",
      }
    }
  } catch {
    /* 不是 JSON，按裸串处理 */
  }
  return { token: text, refresh: "", expires: 0, clientId: OAUTH_CLIENT_ID, accountId: "", source: "" }
}

/** 候选路径：环境变量优先，然后是各平台常见的落点。 */
export function tokenCandidates(env = process.env, home = homedir()) {
  return [
    env.CNB_TOKEN_FILE,
    join(home, ".cnb", "token"),
    join(home, ".config", "cnb", "token"),
    env.APPDATA ? join(env.APPDATA, "cnb", "token") : "",
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "cnb", "token") : "",
  ].filter((p) => typeof p === "string" && p.length > 8)
}

/**
 * 读到就返回 `{ token, refresh, expires, clientId, accountId, source }`，读不到返回 null。
 *
 * `source` 是文件路径（或「CNB_TOKEN 环境变量」），登录失败时告诉用户到底读了哪。
 */
export function readLocalCnbToken({ env = process.env, home = homedir() } = {}) {
  for (const file of tokenCandidates(env, home)) {
    try {
      if (!existsSync(file)) continue
      const parsed = parseTokenText(readFileSync(file, "utf8"))
      if (parsed?.token || parsed?.refresh) return { ...parsed, source: file }
    } catch {
      /* 读不到就试下一个 */
    }
  }
  const fromEnv = String(env.CNB_TOKEN || env.CNB_CLI_TOKEN || "").trim()
  if (fromEnv) {
    return { token: fromEnv, refresh: "", expires: 0, clientId: OAUTH_CLIENT_ID, accountId: "", source: "CNB_TOKEN 环境变量" }
  }
  return null
}
