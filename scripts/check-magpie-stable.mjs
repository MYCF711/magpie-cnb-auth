#!/usr/bin/env node
// check-magpie-stable.mjs —— 该不该同步插件契约？看稳定渠道，不看每版本渠道
//
// 为什么：magpie 的「更新渠道」有两档（设置 › 更新渠道）——
//   每个版本：一晚能发四个（实测 1763→1767），大多是 beta，追它追不完
//   稳定版  ：用户默认跑的就是它，插件契约要跟的是它
// 2026-10-28 实测两档差得很夸张：每版本 0.1.1763 / 稳定版 0.1.1327，
// 但逐字段比对后**插件相关的字段一条不差** —— 所以「追每版本」几乎全是白跑。
//
// 用法：
//   node scripts/check-magpie-stable.mjs
//
// 退出码：0 = 基线就是当前稳定版（不用动）
//         2 = 稳定版变了（按提示重提取 + 比对）
//         1 = 查不到（网络 / feed 变了）

import { readFileSync, existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"

const ROOT = process.cwd()
const HOOKS = join(ROOT, "HOOKS.md")
const FEED = "https://usemagpie.ai/api/latest?channel=stable"

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
}

if (!existsSync(HOOKS)) {
  console.error(C.red("✗ 没有 HOOKS.md —— 请在插件模板仓库根目录跑"))
  process.exit(1)
}

/** HOOKS.md 里那行「当前基线：`0.1.1327`（稳定渠道 / Stable）」 */
const hooks = readFileSync(HOOKS, "utf8").replace(/\r\n/g, "\n")
const m = hooks.match(/当前基线：\**\s*`?(\d+\.\d+\.\d+)`?/)
if (!m) {
  console.error(C.red("✗ HOOKS.md 里找不到「当前基线：`x.y.z`」这一行"))
  console.error(C.dim("  在文件顶部按这个形状加一行：**当前基线：`0.1.1327`（稳定渠道 / Stable）**"))
  process.exit(1)
}
const baseline = m[1]

/** 用系统 curl 查稳定渠道的版本（node 的 fetch 在本机对部分域名不稳，见 release.mjs 的注释） */
function stableVersion() {
  const out = execFileSync("curl", ["-sS", "--max-time", "30", FEED], { encoding: "utf8" })
  const j = JSON.parse(out)
  return { version: String(j.version || ""), channel: String(j.channel || ""), published: String(j.published || "") }
}

let feed
try {
  feed = stableVersion()
} catch (e) {
  console.error(C.red(`✗ 查不到稳定渠道：${String(e.stderr || e.message).trim().slice(0, 160)}`))
  console.error(C.dim(`  地址：${FEED}`))
  process.exit(1)
}

if (!feed.version) {
  console.error(C.red("✗ feed 里没有 version 字段 —— 接口可能变了"))
  process.exit(1)
}

console.log(C.bold("\n插件契约基线检查（稳定渠道）\n"))
console.log(`  基线（HOOKS.md）  ${baseline}`)
console.log(`  稳定版（feed）    ${feed.version}${feed.published ? C.dim(`  ${feed.published.slice(0, 16)}`) : ""}`)
console.log()

function cmp(a, b) {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  return 0
}

const d = cmp(baseline, feed.version)

if (d === 0) {
  console.log(C.green("  ✓ 基线就是当前稳定版 —— 不用动"))
  console.log(C.dim("\n  每版本渠道不用管：它一晚能发四个，插件相关的字段却和稳定版一致。\n"))
  process.exit(0)
}

if (d > 0) {
  console.log(C.yellow(`  ! 基线（${baseline}）比稳定版还新 —— 可能基线写错，或者稳定版回滚了`))
  console.log(C.dim(`\n  确认一下：curl -s "${FEED}"\n`))
  process.exit(2)
}

console.log(C.yellow(`  稳定版已经走到 ${feed.version}，基线还是 ${baseline} —— 该重提取了\n`))
console.log(C.bold("  三步：\n"))
console.log("    1. 下载稳定版并提取它的契约：")
console.log(C.dim(`       curl -sL -o /tmp/magpie-${feed.version}.exe \\`))
console.log(C.dim(`         https://github.com/yetone/magpie-releases/releases/download/v${feed.version}/magpie-windows-amd64.exe`))
console.log(`       python extract-contract.py /tmp/magpie-${feed.version}.exe`)
console.log()
console.log("    2. 看契约里有没有 HOOKS.md 没写的字段：")
console.log("       node scripts/contract-diff.mjs")
console.log()
console.log("    3. 把该补的补进 HOOKS.md 的「十一之三」，然后改顶部那行基线：")
console.log(C.dim(`       **当前基线：\`${feed.version}\`（稳定渠道 / Stable）**`))
console.log()
console.log(C.dim("  ⚠ 只补「不写会关掉某个能力」的字段。差集里剩下的多是 GUI / tools / 内部变量，不用管。\n"))
process.exit(2)
