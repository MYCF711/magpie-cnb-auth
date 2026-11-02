#!/usr/bin/env node
// probe-vision.mjs —— 模型「说自己能收图」，是不是真的？发一张图问它
//
// 为什么：magpie 的模型图片能力有三个来源，谁说了算不一样 ——
//   ① 厂商列表（插件的 capabilities.input.image，宿主按它算 imageSaid）
//   ② models.dev 的**裸模型 id 投票**（插件没说时的兜底）
//   ③ 用户在 Providers › Names & levels 手动勾的 Accepts images（压过前两者）
// ② 会错（同名模型在别家标了 image，实为文本的也被带成能收图），
// ③ 会错（手勾成 true 而厂商说 false）。两种错都不报错：截图直发上游，
// 上游要么回 not multimodal（400/502），要么干脆当没有图，模型答「我看不到图片」。
//
// 实测（2026-10-29，magpie 0.1.1932）：CodeArts 8 个模型漏写 image，
// 四天 161 次被 `The request model is not multimodal (InferHub.001001020.406)` 拒绝；
// ima / magicrew 三个模型厂商说 image:false 却被勾成 true，
// 一个回「图片似乎无法查看」，一个回 400「不支持多模态输入」。
//
// 用法：
//   node scripts/probe-vision.mjs                      # 测网关 /v1/models 里的每个模型
//   node scripts/probe-vision.mjs <provider/model> …   # 只测这几个
//   MAGPIE_GATEWAY=http://127.0.0.1:3425 node scripts/probe-vision.mjs
//   node scripts/probe-vision.mjs --vision-only        # 只测 magpie 设置里的识图模型
//
// 它只读 ~/.config/magpie/settings.json 和本机网关，不发外部请求，不改任何配置。
//
// 它回答的是**端到端**那个问题：「我发一张图，它能不能看见」——
// 直读和「magpie 用识图模型描述后给它」都算能看见（后者是 magpie 的正常机制）。
// 想区分是哪一种、以及这个模型的声明是哪来的，用 `magpie model spec <provider/model>`
// 看 `vision` 一行的来源列：`yours`（手勾）／`the vendor's list / models.dev`。
//
// 退出码：0 = 每个模型都读到了图，或被明确定义为文本模型（400 does not support image input）
//         2 = 发现假声明（图发出去了，模型答「看不见」）—— 这正是要修的那一类
//         1 = 连不上网关，或设置里没识图模型

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const GATEWAY = (process.env.MAGPIE_GATEWAY ?? "http://127.0.0.1:3425").replace(/\/+$/, "")
const CONFIG = join(homedir(), ".config", "magpie", "settings.json")

// 一张 320×120 的白底 PNG，上面写着 MAGPIE-VISION-TEST 42。
// 内嵌是为了自包含：探针要能在任何机器上跑，不依赖工作目录里有没有那张图。
const PROBE_PNG = "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"
const QUESTION = "图片里写了什么字？只回图上的原文，不要解释。"

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
}

/** magpie 设置里那个「识图模型」：Settings › Models › Image recognition */
function visionModel() {
  try {
    const j = JSON.parse(readFileSync(CONFIG, "utf8"))
    const v = String(j?.vision ?? "").trim()
    return !v || v === "off" || v === "none" ? "" : v
  } catch {
    return ""
  }
}

async function modelsFromGateway() {
  const res = await fetch(`${GATEWAY}/v1/models`, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`/v1/models answered ${res.status}`)
  const j = await res.json()
  return (j?.data ?? []).map((m) => m.id).filter(Boolean)
}

/** 问模型一次：这张图里写了什么 */
async function ask(model) {
  const body = {
    model,
    stream: false,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: QUESTION },
          { type: "image_url", image_url: { url: `data:image/png;base64,${PROBE_PNG}` } },
        ],
      },
    ],
  }
  const started = Date.now()
  let res
  try {
    res = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    })
  } catch (e) {
    return { kind: "error", ms: Date.now() - started, detail: String(e?.message ?? e) }
  }
  const text = await res.text()
  const ms = Date.now() - started
  if (!res.ok) {
    if (res.status === 400 && /does not support image input/i.test(text)) return { kind: "text-only", ms, detail: "" }
    return { kind: "error", ms, detail: `${res.status}: ${text.slice(0, 200)}` }
  }
  let answer = ""
  try {
    answer = String(JSON.parse(text)?.choices?.[0]?.message?.content ?? "")
  } catch {
    answer = text.slice(0, 200)
  }
  if (/MAGPIE-VISION-TEST/i.test(answer)) return { kind: "sees", ms, detail: answer.slice(0, 120) }
  if (/不支持多模态|not multimodal|does not support image|无法查看|看不到|无法获取[\s\S]{0,6}图片|cannot (see|view|read) (the )?image|no image|没有(收到|看到)图/i.test(answer)) {
    return { kind: "blind", ms, detail: answer.slice(0, 160) }
  }
  return { kind: "unclear", ms, detail: answer.slice(0, 160) }
}

const argv = process.argv.slice(2)
const onlyVision = argv.includes("--vision-only")
const wanted = argv.filter((a) => !a.startsWith("--"))

let models = wanted
if (models.length === 0) {
  const vision = visionModel()
  if (onlyVision) {
    if (!vision) {
      console.error(C.red("✗ magpie 的 Settings › Models › Image recognition 没设模型（或设为 off）"))
      process.exit(1)
    }
    models = [vision]
  } else {
    try {
      models = await modelsFromGateway()
    } catch (e) {
      console.error(C.red(`✗ 连不上 magpie 网关 ${GATEWAY} —— ${e?.message ?? e}`))
      console.error(C.dim(`  先确认 magpie 在跑：curl -s -o /dev/null -w 'HTTP %{http_code}\n' ${GATEWAY}/v1/models`))
      process.exit(1)
    }
  }
}

const vision = visionModel()
console.log(C.bold(`探针：${GATEWAY}  共 ${models.length} 个模型`))
console.log(C.dim(vision ? `识图模型（Settings）：${vision}` : "识图模型（Settings）：未设置"))
console.log("")

const tally = { sees: 0, blind: 0, "text-only": 0, unclear: 0, error: 0 }
for (const model of models) {
  const r = await ask(model)
  tally[r.kind] = (tally[r.kind] ?? 0) + 1
  const ms = C.dim(`${(r.ms / 1000).toFixed(1)}s`)
  if (r.kind === "sees") console.log(`${C.green("✓ 能读到图")}  ${model}  ${ms}`)
  else if (r.kind === "blind") console.log(`${C.red("✗ 假声明  ")}  ${model}  ${ms}\n              ${C.dim(r.detail)}`)
  else if (r.kind === "text-only") console.log(`${C.cyan("· 已标文本")}  ${model}  ${ms}  ${C.dim("magpie 会替它描述图片或把图片略去")}`)
  else if (r.kind === "unclear") console.log(`${C.yellow("? 看不出  ")}  ${model}  ${ms}\n              ${C.dim(r.detail)}`)
  else console.log(`${C.yellow("! 请求失败")}  ${model}  ${ms}\n              ${C.dim(r.detail)}`)
}

console.log("")
console.log(
  `能读到图 ${tally.sees} · 假声明 ${tally.blind} · 已标文本 ${tally["text-only"]} · 看不出 ${tally.unclear} · 失败 ${tally.error}`,
)
console.log(C.dim("「能读到图」含两种：模型自己看，或 magpie 用识图模型描述后给它（两者都是正常机制）。"))

if (tally.blind > 0) {
  console.log("")
  console.log(C.red("「假声明」= magpie 当它能收图、把图直发上游，而上游看不见（或直接拒绝）。修法二选一："))
  console.log("  · 厂商真的收不了图 → 插件里把 image 写成 false（HOOKS 十一之三的 TEXT_ONLY 模板）；")
  console.log("  · 只是 models.dev 投票带偏 / 手勾错了 → magpie model spec <model> --vision off")
  process.exit(2)
}
process.exit(0)
