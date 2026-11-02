// src/http.mjs —— 一次请求的公共外壳：UA / 超时 / 错误出口
//
// 为什么单独一个文件：**错误语义只在一处定义**。这个插件有三条完全不同的上游
// （cnb.cool 网页侧、api.cnb.cool OpenAPI、用户自建中继），但它们对 magpie 说话
// 只能有一种口径，否则「模型不可用」会被写成 401，一次请求失手就打死整个账号。

import { USER_AGENT } from "./context.mjs"

/**
 * 错误码词表 —— 与 ERROR-CODES.md §3 一致，改这里就等于改契约。
 *
 * 宿主按 `status` 换号 / 换模型 / 退避，按 `code` 做程序分支，`message` 给人看。
 * 三个都不能省：省了 status 宿主不知道该怎么办，省了 code 日志里分不清，
 * 只写「服务异常」的话用户和 agent 都无从下手。
 */
export const CODES = Object.freeze({
  signInRequired: "sign_in_required", // 401 没凭据 / 从未登录
  sessionExpired: "session_expired", // 401 凭据失效
  auditBlocked: "audit_blocked", // 400 内容被风控拦
  invalidRequest: "invalid_request", // 400 参数不合法
  modelNotFound: "model_not_found", // 404 这个模型不可用（只搁置它）
  concurrencyConflict: "concurrency_conflict", // 409
  rateLimited: "rate_limited", // 429
  upstreamUnavailable: "upstream_unavailable", // 503 上游 5xx
  upstreamTimeout: "upstream_timeout", // 504 超时 / 流被截断
  upstreamError: "upstream_error", // 502 默认桶
  internalError: "internal_error", // 502 插件自己的 bug
  notImplemented: "not_implemented", // 501 不支持的端点 / 能力
})

/**
 * 公共请求头。
 *
 * ⚠ `User-Agent` 是硬要求：CNB 前面是 Cloudflare，缺 UA 直接回
 * `403 Error 1010 browser_signature_banned`（HTML，不是 JSON）——
 * 看起来像「仓库路径错了」，实际只差一个头。
 */
export function baseHeaders(extra = {}) {
  return {
    "user-agent": USER_AGENT,
    accept: "application/json",
    ...extra,
  }
}

/** 造一个 JSON Response。 */
export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  })
}

/**
 * **聊天通道的唯一错误出口。**
 *
 * 名字和三个位置参数被 scripts/check-error-codes.mjs 静态检查锁住：
 * 第三个参数必须是词表里的字面量，所以任何调用都不许省 code。
 *
 * @param {string} message  给人看的，必须保留上游原文
 * @param {number} status   HTTP 状态码（决定宿主换号 / 换模型 / 退避）
 * @param {string} code     CODES 里的字面量
 * @param {object} [extra]  额外响应头等
 */
export function errorResponse(message, status, code, extra = {}) {
  const text = String(message ?? "").trim() || "上游没有返回内容"
  const { signIn, ...headers } = extra
  return jsonResponse(
    { error: { message: text, type: code, code, status } },
    status,
    signIn ? { "x-magpie-sign-in": signIn, ...headers } : headers,
  )
}

/** 把异常包成一条「上游业务错误」，status 决定宿主怎么处理。 */
export function upstreamError(message, status = 0) {
  const error = new Error(String(message ?? ""))
  if (status) error.status = status
  return error
}

/** 上游给的错误体可能不是 JSON（Cloudflare 的 HTML、空 body）。尽量读成人话。 */
export async function readBody(response) {
  try {
    const text = await response.text()
    if (!text) return {}
    try {
      return JSON.parse(text)
    } catch {
      return { _text: text }
    }
  } catch {
    return {}
  }
}

/** 从任意形状的错误体里挖出一句人话。 */
export function errorText(body) {
  if (body == null) return ""
  if (typeof body === "string") return body.slice(0, 400)
  const parts = []
  for (const key of ["errmsg", "message", "msg", "error_description", "error", "detail", "code"]) {
    const v = body[key]
    if (v == null || v === "") continue
    parts.push(typeof v === "object" ? JSON.stringify(v) : String(v))
  }
  if (!parts.length && body._text) parts.push(String(body._text).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300))
  return parts.join(" · ").slice(0, 400)
}

/**
 * 带默认值的 signal：调用方的 signal 优先，其次给一个超时。
 * 没有超时的 fetch 会挂死整张卡片 —— 这是四个真实插件里都出现过的坑。
 */
export function abortSignal(signal, timeoutMs) {
  if (signal) return signal
  return Number(timeoutMs) > 0 ? AbortSignal.timeout(timeoutMs) : undefined
}

/**
 * 上游 401/403 到底是不是「登录失效」？
 *
 * ⚠ 这是整份代码里最贵的一个判断：
 *   判成「失效」→ magpie 停掉这个账号、failover 到每一个账号（坑 6）；
 *   判成「不是」→ 用户拿一个看不懂的 403 干瞪眼。
 *
 * 判据（与参考实现一致，来自实测）：
 *   401 —— 只要**不是**在说模型问题，就是登录问题
 *   403 —— 只有明说 not_logged_in / login / session / csrf / 登录，才算登录问题
 *           （403 的常见来源是「这个模型你没权限」和 CF 的 bot 拦截，两者都不该停账号）
 */
export function isLoginBroken(status, body) {
  const text = errorText(body).toLowerCase()
  if (Number(status) === 401) {
    const modelish = /model|not available|model_not_found|模型不支持/.test(text)
    const authish = /token|key|session|login|登录/.test(text)
    return !modelish || authish
  }
  if (Number(status) === 403) return /not_logged_in|login|session|csrf|登录|未登录/.test(text)
  return false
}
