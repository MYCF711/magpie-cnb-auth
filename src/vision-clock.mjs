// 识图判角度 —— 用 magpie 里**用户自己配的那个识图模型**
//
// 适用于任何「旋转图片使角度为正」的验证码：答案只存在于图片里，协议层只能把
// 「怎么提交」做到位，「该提交多少度」必须有人看图。
//
// 三条实测结论决定了这里怎么写（来自 magicrew 插件 2026-10-28/29 的真机数据）：
//
//  ① **不能问「多少度」，要问「主体的上方向指向钟面几点」。**
//     直接问角度（填空）6 次错 5 次；改成钟点（相对描述）3 轮中 2。
//     让模型「在脑子里把图转过来」它做不好，问「现在朝哪」它答得稳。
//
//  ② **必须问两次并比分歧。**
//     实测失败案例：两个判官给出 1.7 和 7.5 钟点（相差 174°）——其中一个把方向
//     看反了。这种情况取平均毫无意义，只能判「不可信」换图重来。
//
//  ③ **模型是用户在 magpie 设置里选的那个**（`settings.json` 的 `vision`），
//     插件不额外要求配 key —— magpie 自己监听着一个 OpenAI 兼容网关，打本地端口即可。
//
// ⚠ 模型回什么形状都可能（带解释、带思考过程、结尾才有数字），解析一律
//   「从后往前找最后一个合法数字」，找不到就算这次不可信。

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** 两个判官分歧超过这个值（钟点）就认为「有人把方向看反了」 */
export const CLOCK_MAX_SPREAD = 1.5

/**
 * 钟点 → 顺时针旋转角度。
 *
 * 判官回答的是「主体自己的上方向指向钟面的几点」（12=正上、3=正右）。
 * 图要**顺时针**转多少度才立起来 = (12 - clock) * 30。
 */
export function clockToDeg(clock) {
  const x = Number(clock)
  if (!Number.isFinite(x)) return null
  return Math.round((((12 - x) * 30) % 360 + 360) % 360)
}

/** 两个判官分歧多大（按钟点，取最短环距 0…6） */
export function clockSpread(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 6
  const d = Math.abs(((a - b) % 12 + 12) % 12)
  return Math.min(d, 12 - d)
}

/** magpie 的配置目录；Windows 上是 ~/.config/magpie，和别的系统一致 */
export function magpieConfigDir() {
  return join(homedir(), ".config", "magpie")
}

/**
 * 用户选的识图模型。
 * @returns {string|null} 形如 `workbuddy/deepseek-v4.1-flash`；没配 / 关掉 / 读不到 → null
 */
export function readVisionModel() {
  try {
    const raw = readFileSync(join(magpieConfigDir(), "settings.json"), "utf8")
    const j = JSON.parse(raw)
    const v = String(j?.vision ?? "").trim()
    if (!v || v === "off" || v === "none" || v === "0") return null
    return v
  } catch {
    return null
  }
}

/**
 * magpie 自己的网关端口。
 *
 * 默认 3425（本机实测 `magpie-windows-amd64.exe` 就监听这个）。
 * 用户能通过 `magpie web --addr host:port` / `magpie serve` 改，所以：
 *   · 环境变量优先（万一 magpie 把它传进插件进程）
 *   · 否则按常见端口列表逐个试 —— **只看谁能以 200 回 /v1/models**
 */
export function gatewayCandidates() {
  const fromEnv = [process.env.MAGPIE_GATEWAY_PORT, process.env.MAGPIE_PORT]
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0)
  const common = [3425, 3426, 8080]
  return [...new Set([...fromEnv, ...common])]
}

let cachedBase = null

/** 测试用：清掉网关缓存（正常运行时不需要） */
export function resetGatewayCache() {
  cachedBase = null
}

/** 探一个能用的网关基址；找到就记住，找不到返回 null */
export async function resolveGatewayBase() {
  if (cachedBase) return cachedBase
  for (const port of gatewayCandidates()) {
    const base = `http://127.0.0.1:${port}/v1`
    try {
      const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) {
        cachedBase = base
        return base
      }
    } catch {
      /* 这个端口没在听，试下一个 */
    }
  }
  return null
}

/**
 * webp → png 的 data URL。
 *
 * 为什么：验证码图常是 `data:image/webp`，不是每个视觉模型都吃 webp。
 * magpie 自带的 bun 有 `Bun.Image`（实测能解 webp），没有它的环境就原样返回。
 */
export async function toPngDataUrl(imageDataUrl) {
  if (!/^data:image\/webp/i.test(imageDataUrl)) return imageDataUrl
  try {
    if (typeof Bun === "undefined" || typeof Bun.Image !== "function") return imageDataUrl
    const b64 = imageDataUrl.split(",")[1] || ""
    const img = new Bun.Image(Buffer.from(b64, "base64"))
    await img.metadata()
    img.png()
    const out = await img.toBuffer()
    return "data:image/png;base64," + Buffer.from(out).toString("base64")
  } catch {
    return imageDataUrl
  }
}

const CLOCK_PROMPT = (variant) => {
  const frame =
    variant === 0
      ? "想象一个钟面盖在图上：12 = 正上方，3 = 正右方，6 = 正下方，9 = 正左方。"
      : "把这张图当成表盘：最上方是 12 点，顺时针数到 3 点在右、6 点在正下、9 点在左。"
  return `这张图片被随机旋转过，是圆形裁切的照片，里面有一个主体。
${frame}
判断：主体自己的"上方向"（人的头顶、动物的头顶、瓶子口、相机顶部那一侧）现在指向钟面的几点？
要精确，允许一位小数（例如 7.3）。
最后一行只输出这个数字，不要写别的。`
}

/** 从一段话里取「最后出现的、落在 0…12 的数」—— 模型常在前面铺垫一堆 */
function lastClock(text) {
  const nums = String(text || "").match(/\d+(?:\.\d+)?/g)
  if (!nums) return null
  for (let i = nums.length - 1; i >= 0; i--) {
    const v = Number(nums[i])
    if (Number.isFinite(v) && v >= 0 && v <= 12) return v
  }
  return null
}

async function askClock(base, model, imageDataUrl, variant) {
  const body = {
    model,
    // ⚠ 这个上限是**给推理 token 留的**，不是给答案留的。
    //   ＊ 实测：max_tokens=400 时 finish_reason:"length"、content 是 null ——
    //     推理把额度吃干净，判官拿到空串 ⇒ 判「不可信」⇒ 整条登录挂掉。
    //     给到 6000 时 reasoning 用 899 就收尾，content 正常回 "10"。
    max_tokens: 6000,
    // ⚠ reasoning_effort: "low" —— 实测有据的省法（同一模型同一批图，各 6 轮）：
    //
    //     |          | 出数字 | 平均耗时 | 平均 tokens | 平均 reasoning |
    //     | 不传      |  5/6   | 20.6 s   |   2343      |    3581 字     |
    //     | low       |  6/6   |  8.4 s   |   1007      |    1646 字     |
    //
    //   更快、更省、还更稳（不传的那组有一次把 6000 token 全烧在思考上、content 交白卷）。
    //   ⚠ 别指望彻底关思考：该模型在网关侧关不掉（enable_thinking:false /
    //     thinking_budget:0 / reasoning_effort:"none" 都试过，反而更长）。
    //     要真不思考，只能换一个**非推理**视觉模型（由用户在 magpie 设置里选）。
    //
    //   ⚠ 它**不是** OpenAI 规范字段：下面 send() 有一层兜底，被 400 就去掉重发。
    reasoning_effort: "low",
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: CLOCK_PROMPT(variant) },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
  }

  const send = (b) =>
    fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(b),
      signal: AbortSignal.timeout(90_000),
    })

  let res = await send(body)
  if (res.status === 400 && Object.hasOwn(body, "reasoning_effort")) {
    // 兼容兜底：识图模型是**用户自己选的**（模型库/自定义 provider 什么都可能有），
    // 有的 OpenAI 兼容端认这个字段，有的为未知字段直接回 400。宁可少省几秒，
    // 也不要因为一个可选优化把整条登录打死 —— 去掉重发一次，退回「不传」那档。
    delete body.reasoning_effort
    res = await send(body)
  }
  if (!res.ok) throw new Error(`识图模型回 HTTP ${res.status}`)
  const j = await res.json()
  const m = j?.choices?.[0]?.message ?? {}
  const content = String(m.content ?? "").trim()
  const reasoning = String(m.reasoning_content ?? "")
  // ① 正常情况：答案在 content 里
  if (content) return { clock: lastClock(content), text: content.slice(-200), from: "content" }
  // ② 兜底：推理模型被截断、content 为空 —— 答案在 reasoning 的最后一段里
  //    （实测尾巴就是「最终决定：10。」这种形状）。只看最后 300 字，
  //    别把前面推理中间提到的钟点当答案。
  if (reasoning) {
    const tail = reasoning.slice(-300)
    return { clock: lastClock(tail), text: tail.slice(-200), from: "reasoning" }
  }
  return { clock: null, text: "", from: "empty" }
}

/**
 * 让识图模型判断「该顺时针转多少度」。
 *
 * @param {string} imageDataUrl 验证码图的 data URL
 * @param {{model?:string}} [opts] `model` 可覆盖设置里那个（给对比脚本 / 测试用；
 *   正常运行不传，读用户选的）
 * @returns {Promise<{ok:true, deg:number, clock:number, spread:number, model:string}
 *                  |{ok:false, reason:string, detail?:string}>}
 */
export async function decideDegFromImage(imageDataUrl, { model: overrideModel } = {}) {
  const model = overrideModel || readVisionModel()
  if (!model) return { ok: false, reason: "no-vision-model" }

  const base = await resolveGatewayBase()
  if (!base) return { ok: false, reason: "no-gateway", detail: "连不上 magpie 自己的网关（试过 3425/3426/8080）" }

  const img = await toPngDataUrl(imageDataUrl)
  // ⚠ **两个判官并行**：串行等两次就把延迟叠成两倍（实测单次 5～20 秒），
  //   而它们互不依赖 —— 一起发，耗时等于较慢的那一次。
  const [a, b] = await Promise.all([
    askClock(base, model, img, 0).catch((e) => ({ clock: null, text: String(e?.message ?? e) })),
    askClock(base, model, img, 1).catch(() => ({ clock: null, text: "" })),
  ])

  if (a.clock == null && b.clock == null) {
    return { ok: false, reason: "unparsable", detail: `${a.text} / ${b.text}` }
  }
  // 只拿到一个也能用（另一个多半是被截断或跑题了）
  if (a.clock == null || b.clock == null) {
    const one = a.clock ?? b.clock
    return { ok: true, deg: clockToDeg(one), clock: one, spread: 0, model, single: true }
  }

  const spread = clockSpread(a.clock, b.clock)
  if (spread > CLOCK_MAX_SPREAD) {
    // 相差超过 1.5 钟点（45°）基本就是「有一个人把方向看反了」，
    // 这时候取平均只会得到一个两边都不对的中间值 —— 宁可换一张图重来
    return {
      ok: false,
      reason: "disagree",
      detail: `${a.clock} vs ${b.clock}（相差 ${spread.toFixed(1)} 钟点）`,
      spread,
    }
  }

  const clock = (a.clock + b.clock) / 2
  return { ok: true, deg: clockToDeg(clock), clock, spread, model }
}