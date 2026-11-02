// src/request-rewrite.mjs —— JSON 请求体改写管道（纯函数，默认不改用户请求）
//
// 为什么需要它：OpenAI 兼容的 loader 里，几乎每个成熟插件都有「一次 parse、几处原地改」：
//   · stream:true 要补 stream_options.include_usage，否则上游不回 usage
//   · 上游要求 max_tokens 有下限，客户端给的 128 会被 400
//   · 模型名带 `vendor/` 前缀时要剥掉
// 这些改写都很小，但写错会「看起来正常、结果不对」；而且改 body 后必须去掉
// content-length / content-encoding，否则响应会被截断或解码失败。
//
// 本模块只提供管道和三个内置 transform，**不接管 loader、不默认改写请求**。
// 调用方显式列出要用的 transform；工具 schema 兼容故意不内置 —— 那是放宽用户
// schema，必须由派生插件按自己的上游显式开启。

export const DEFAULT_FAST_RE =
  /"(?:stream|stream_options|max_tokens|max_completion_tokens|model)"\s*:/

/**
 * 先粗筛关键字，再 parse；没有命中关键字时返回**原字符串引用**（不复制、不改写）。
 * 坏 JSON 同样原样返回，让上游去报错 —— 这里不替上游决定「坏 JSON 该修成什么」。
 *
 * @param {unknown} raw
 * @param {((body: object) => boolean)[]} transforms 每个 transform 原地改，返回是否 changed
 * @param {{fastRe?: RegExp|null}} [options] fastRe=null 表示不粗筛（自定义字段时用）
 * @returns {unknown} 原字符串或改写后的 JSON 字符串
 */
export function rewriteJsonBody(raw, transforms, { fastRe = DEFAULT_FAST_RE } = {}) {
  if (typeof raw !== "string") return raw
  if (!Array.isArray(transforms)) throw new TypeError("rewriteJsonBody: transforms 必须是数组")
  if (fastRe instanceof RegExp && !fastRe.test(raw)) return raw

  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return raw
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return raw

  let changed = false
  for (const transform of transforms) {
    if (typeof transform !== "function") throw new TypeError("rewriteJsonBody: 每个 transform 必须是函数")
    if (transform(body) === true) changed = true
  }
  return changed ? JSON.stringify(body) : raw
}

/** `stream:true` 时补 `stream_options.include_usage`；`stream:false` 不动。 */
export function ensureStreamUsage(body) {
  if (!body || body.stream !== true) return false
  if (body.stream_options?.include_usage === true) return false
  body.stream_options = { ...(body.stream_options || {}), include_usage: true }
  return true
}

/**
 * `max_tokens` / `max_completion_tokens` 低于下限时抬高。
 * 非有限数字不改（让上游报它自己的参数错误）。
 */
export function clampMaxTokens(min = 512) {
  if (!Number.isInteger(min) || min <= 0) throw new TypeError(`clampMaxTokens: min 必须是正整数，收到 ${min}`)
  return (body) => {
    if (!body || typeof body !== "object") return false
    let changed = false
    for (const key of ["max_tokens", "max_completion_tokens"]) {
      const value = body[key]
      if (typeof value !== "number" || !Number.isFinite(value)) continue
      if (value < min) {
        body[key] = min
        changed = true
      }
    }
    return changed
  }
}

/**
 * 剥掉模型名前面的一个或多个前缀（按给定顺序）。
 * `stripModelPrefix("acme")` 会把 `acme/glm-5` 变成 `glm-5`，不改不匹配的值。
 */
export function stripModelPrefix(prefix) {
  const prefixes = (Array.isArray(prefix) ? prefix : [prefix])
    .filter((p) => typeof p === "string" && p !== "")
    .map((p) => (p.endsWith("/") ? p : `${p}/`))
  if (prefixes.length === 0) throw new TypeError("stripModelPrefix: 至少给一个非空前缀")
  return (body) => {
    if (!body || typeof body.model !== "string") return false
    for (const p of prefixes) {
      if (body.model.startsWith(p)) {
        body.model = body.model.slice(p.length)
        return true
      }
    }
    return false
  }
}

/**
 * 改过 body 之后必须调用：去掉 `content-length` 与 `content-encoding`。
 * 支持 `Headers`、`Response`，以及带 `headers` 的普通对象（返回新 Response）。
 */
export function stripHopHeaders(input) {
  const drop = (headers) => {
    headers.delete("content-length")
    headers.delete("content-encoding")
    return headers
  }
  if (input instanceof Headers) return drop(new Headers(input))
  if (input instanceof Response) {
    return new Response(input.body, {
      status: input.status,
      statusText: input.statusText,
      headers: drop(new Headers(input.headers)),
    })
  }
  if (input && input.headers instanceof Headers) {
    return new Response(input.body, {
      status: input.status ?? 200,
      statusText: input.statusText ?? "",
      headers: drop(new Headers(input.headers)),
    })
  }
  throw new TypeError("stripHopHeaders: 需要 Headers、Response 或带 headers 的对象")
}

/** 常用组合：补 usage + 抬 max_tokens；不碰模型名和工具 schema。 */
export function rewriteRequest(raw, { minTokens = 512 } = {}) {
  return rewriteJsonBody(raw, [ensureStreamUsage, clampMaxTokens(minTokens)])
}