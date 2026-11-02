#!/usr/bin/env node
// contract-diff.mjs —— magpie 升级后，自动找出「契约里有、HOOKS.md 没写」的字段
//
// 为什么要有它：0.1.14 那一次是靠人手比对发现 HOOKS.md 漏了 6 个字段
// （searches / decides / rateWas / fast / serviceTiers / modalities），
// 而它们全是「不写就等于关掉某个能力」，不会报错。magpie 一周好几个版本，
// 靠自觉比对必然漏 —— 把比对做成命令。
//
// 用法：
//   python extract-contract.py            # 先重新提取当前二进制的契约
//   node scripts/contract-diff.mjs        # 再跑这个，看差集
//
// 退出码：0 = 没有新字段；2 = 有差集（列出前 40 个，人工判断哪些该写进 HOOKS.md）

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const CONTRACT = join(ROOT, "magpie-plugin-contract-full.txt")
const HOOKS = join(ROOT, "HOOKS.md")

if (!existsSync(CONTRACT)) {
  console.error(`\n没有 ${CONTRACT}\n  先跑：python extract-contract.py\n`)
  process.exit(1)
}
if (!existsSync(HOOKS)) {
  console.error(`\n没有 HOOKS.md —— 请在模板仓库根目录跑\n`)
  process.exit(1)
}

const contractAll = readFileSync(CONTRACT, "utf8")
const hooks = readFileSync(HOOKS, "utf8")

// 内嵌契约里混着 GUI / sidebar / summaries / tools 等与插件无关的章节。
// 只扫「插件那几段」：从 `// ---- one provider's hooks` 到文件末（the loop 是最后一段）。
// 不切的话假阳性会从个位数涨到 90+，信号被噪声淹掉。
const START = "// ---- one provider's hooks"
const startAt = contractAll.indexOf(START)
const contract = startAt >= 0 ? contractAll.slice(startAt) : contractAll
if (startAt < 0) console.log("⚠ 没找到「one provider's hooks」这一段，退回全文扫描（噪声会很多）\n")

/**
 * 契约里的「字段名」。两种形状：
 *   `  name: m.name ?? …`          → name
 *   `  rate: rateOf(m.rate),`      → rate
 * 只取行首缩进 1-6 空格的 `key:`，避开对象字面量里的嵌套与注释。
 */
const contractFields = new Set()
for (const line of contract.split("\n")) {
  if (/^\s*\/\//.test(line)) continue // 注释行跳过
  const m = line.match(/^\s{1,6}([a-zA-Z][a-zA-Z0-9_]{2,30})\s*:/)
  if (m) contractFields.add(m[1])
}

/** HOOKS.md 里凡是写成 `xxx` 的都算「提到过」。宁可宽一点，少报假阳性。 */
const hooksMentioned = new Set()
for (const m of hooks.matchAll(/`([a-zA-Z][a-zA-Z0-9_]{2,30})`/g)) hooksMentioned.add(m[1])
// 正文里不带反引号也算提到（中文行文里常见）
const hooksText = hooks.toLowerCase()

/** 这些是 magpie 内部机制名，不是插件该写的东西 —— 白名单掉，免得噪声淹没信号 */
const INTERNAL = new Set([
  "const",
  "let",
  "return",
  "typeof",
  "await",
  "async",
  "function",
  "export",
  "import",
  "undefined",
  "require",
  "module",
  "process",
  "window",
  "document",
  "console",
  "Promise",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Symbol",
])

const missing = [...contractFields]
  .filter((f) => !hooksMentioned.has(f) && !hooksText.includes(f.toLowerCase()))
  .filter((f) => !INTERNAL.has(f))
  .sort()

console.log(`\n契约字段 ${contractFields.size} 个 · HOOKS.md 提到 ${hooksMentioned.size} 个标识符`)
console.log(`→ 契约里有、HOOKS.md 一个字都没提的：${missing.length} 个\n`)

if (!missing.length) {
  console.log("  （空 —— 这一份没有落后于当前二进制）\n")
  process.exit(0)
}

for (const f of missing.slice(0, 40)) console.log(`  ${f}`)
if (missing.length > 40) console.log(`  … 还有 ${missing.length - 40} 个`)

console.log(`
下一步：从上面挑出「插件该写的字段」（模型条目 / provider 条目上的），补进
HOOKS.md 的「十一之三、模型条目上的全部字段」，并在 AGENTS.md 的坑表加一行。
其余的（magpie 内部变量、GUI 字段）不用管 —— 这个脚本宁可多报，不要漏报。

⚠ 判断依据：这个字段**不写**会不会让某个能力悄悄关掉？
   会 → 必须写。不会（只是显示用）→ 可以不写。
`)
process.exit(2)
