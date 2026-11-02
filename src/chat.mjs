// src/chat.mjs —— 请求接管：把 agent 的 chat 请求投到 CNB 的两条通道上
//
// 通道由 options.transport 决定（`auto` 的顺序是 relay → cookie）：
//
//   relay   你的中继机 /v1/chat/completions              ✅ tools 原生、直通
//   cookie  https://cnb.cool/{repo}/-/ai/chat/completions ❌ 上游结构性拒绝 tools
//
// 两条通道都要做三件事，缺一件就出错：
//   ① **恒以 `stream:true` 调上游** —— CNB 对非流式直接回业务码 11101；
//      客户端要非流式时由这里把 SSE **折叠**成一次性 chat.completion
//   ② 剥掉上游明令禁止的字段（tools / tool_choice / response_format / stream_options）
//   ③ 每个错误出口都带 status + code（见 src/http.mjs 的 CODES）

import { DEFAULT_MODEL, WEB_BASE } from "./context.mjs"
import { CODES, baseHeaders, errorResponse, errorText, isLoginBroken, jsonResponse, readBody } from "./http.mjs"
import { ensureCredential, rawCredentialOf, resolveAccount } from "./credential.mjs"
import { fetchCsrf } from "./api.mjs"
import { foldOpenAI, openAIEvents } from "./openai-sse.mjs"

/**
 * 上游不接受的字段。
 *
 * `stream_options` 也在里面 —— 想「顺手要个 usage」而加它，会被上游整条拒绝，
 * 而报错信息完全不提是这个字段的锅。
 */
export const FORBIDDEN_UPSTREAM_KEYS = Object.freeze(["tools", "tool_choice", "response_format", "stream_options"])

/** 把 body 改成「上游肯吃」的形状：强制流式 + 删掉禁字段。 */
export function cleanPayload(payload) {
  const out = { ...(payload && typeof payload === "object" ? payload : {}) }
  for (const key of FORBIDDEN_UPSTREAM_KEYS) delete out[key]
  out.stream = true
  return out
}

/**
 * 一条请求里有没有 tools。
 *
 * ⚠ 这条判断必须**在发请求之前**做完：CNB 会用 `403 Agent calls are not allowed`
 *   结构性地拒绝，而那个 403 长得很像登录问题 —— 直接透传会让 magpie 停掉整个账号。
 */
export function wantsTools(payload) {
  return Array.isArray(payload?.tools) && payload.tools.length > 0
}

/**
 * 通道判定：显式配置优先，`auto` 按 relay → cookie。
 *
 * ⚠ `none` 的含义是**这条账号一条通道都没有**（没凭据），不是「有凭据但缺 CNBSESSION」。
 *   后者必须落到 `cookie` —— 因为 CNB 的访问令牌（PAT）调不了模型端点（上游一律 403
 *   [NO_RIGHT]），而 `buildCookieFetch` 会给出准确的一句话（「缺 CNBSESSION，粘贴一下」）。
 *   以前这里对「有 PAT 没 session」返回 `none`，`loader` 于是返回 `{}`，宿主只能拿
 *   `provider.api` 去拼一条根本不存在的 `/chat/completions` —— 用户看到的是
 *   迷惑的 **404 Not Found**（2026-11-02 在本机 magpie 上实测）。
 */
export function pickTransport(account, options = {}) {
  const wanted = String(options.transport || "auto").toLowerCase()
  const hasRelay = Boolean(String(options.relay?.url || "").trim())
  // 一条凭据就够了（PAT 或 CNBSESSION 都算）：缺什么由通道自己说清楚。
  const hasCredential = Boolean(account?.raw || account?.token || account?.session)
  if (wanted === "relay") return hasRelay ? "relay" : "none"
  if (wanted === "cookie") return hasCredential ? "cookie" : "none"
  if (hasRelay) return "relay"
  return hasCredential ? "cookie" : "none"
}

/** 中继的 baseURL：去掉尾斜杠与 `/v1`，SDK 自己会拼 `/chat/completions`。 */
export function relayBase(url) {
  return String(url || "").trim().replace(/\/+$/, "").replace(/\/v1$/, "")
}

/** 把上游 SSE 折叠成一次性 chat.completion（上游只吃 stream:true）。 */
export async function foldSse(response, model) {
  const events = openAIEvents(response.body, { onInvalid: "skip" })
  return foldOpenAI(events, { model: String(model || DEFAULT_MODEL) })
}

/** 请求体：`input` 可能是个 Request，也可能只是字符串 URL。 */
async function requestBody(input, init) {
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined)
  if (raw == null || raw === "") return {}
  if (typeof raw === "string") return JSON.parse(raw)
  if (raw instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(raw))
  if (typeof raw === "object") return raw
  throw new TypeError("请求体必须是 JSON")
}

/** 请求 URL —— 兼容 URL / string / Request。 */
export function requestUrl(input) {
  try {
    return input instanceof Request ? input.url : String(input)
  } catch {
    return ""
  }
}

/**
 * cookie 通道的「上游状态码 → 宿主状态码」。
 *
 * 规则只有三条，全部来自 ERROR-CODES §2：
 *   · **登录失效 → 401**：这是唯一该让宿主把账号摘掉的时候。
 *   · **不是登录问题的 401 / 403 → 502**：401 落 401 会让宿主把号标成「要重新登录」，
 *     而真实原因可能只是这条请求；403 更没有宿主语义。两者都进 `upstream_error`
 *     （换号有救、不会误杀账号，message 里保留上游原文）。
 *   · **HTML 响应 → 502**：那是 Cloudflare / 网关页，不是业务错误体。
 */
export function statusForCookie(upstreamStatus, { htmlInstead = false, loginBroken = false } = {}) {
  if (htmlInstead) return 502
  if (loginBroken) return 401
  const n = Number(upstreamStatus) || 0
  if (n === 401 || n === 403) return 502
  return statusForUpstream(n)
}

/** 上游状态码 → 宿主认识的状态码。这些映射错了宿主就会换错东西（ERROR-CODES §2）。 */
export function statusForUpstream(status) {
  const n = Number(status) || 0
  if (n === 400 || n === 401 || n === 404 || n === 409 || n === 429) return n
  if (n >= 500) return 503
  return 502
}

/** 状态码 → 词表里的 code。 */
export function codeForStatus(status) {
  const n = Number(status) || 0
  if (n === 400) return CODES.invalidRequest
  if (n === 401) return CODES.sessionExpired
  if (n === 404) return CODES.modelNotFound
  if (n === 409) return CODES.concurrencyConflict
  if (n === 429) return CODES.rateLimited
  if (n === 503) return CODES.upstreamUnavailable
  return CODES.upstreamError
}

/**
 * cookie 通道：CNB 网页登录态直连。
 *
 * **永远返回 Response** —— 从 fetch 里抛异常会让宿主拿到未捕获的错误，整轮失败
 * 而用户只看到「插件坏了」。
 */
export function buildCookieFetch({ getAuth, options }) {
  return async function cookieFetch(input, init = {}) {
    const auth = await getAuth()
    let record
    try {
      record = await ensureCredential(auth, { options })
    } catch (error) {
      // ⚠ 只有**真的是登录问题**才落 401。`identifyCredential` 打 `/user` 时网络抖一下
      //   （api.cnb.cool 回 5xx / 连不上）也会抛 —— 那把它说成「登录失效」会让宿主
      //   把账号摘掉、failover 到每一个账号，用户还得重新登录一次，而其实什么都没坏。
      const upstreamStatus = Number(error?.status) || 0
      if (error?.signIn === "expired" || upstreamStatus === 401) {
        return errorResponse(String(error?.message || error), 401, CODES.sessionExpired, { signIn: "expired" })
      }
      if (upstreamStatus >= 500 || upstreamStatus === 0) {
        return errorResponse(
          `识别 CNB 凭据时上游不可用：${error?.message || error}`,
          503,
          CODES.upstreamUnavailable,
        )
      }
      return errorResponse(String(error?.message || error), upstreamStatus, codeForStatus(upstreamStatus))
    }

    const account = resolveAccount(auth, options)
    const session = record?.session || account.session
    const csrfkey = record?.csrfkey || account.csrfkey

    if (!session) {
      return errorResponse(
        "这条账号还没有 CNBSESSION：CNB 的访问令牌（PAT）调不了模型（上游一律 403 [NO_RIGHT]）。" +
          "点「粘贴访问令牌」把浏览器里的 CNBSESSION 粘进去，或把 transport 设为 relay 走中继。",
        401,
        CODES.signInRequired,
        { signIn: "expired" },
      )
    }
    const repo = account.repo
    if (!repo) {
      return errorResponse(
        "缺少仓库路径：CNB 的 AI 端点挂在 /{org}/{repo}/-/ai 下。在插件选项里填 org 与 repo，或重新登录一次让插件自动探测。",
        400,
        CODES.invalidRequest,
      )
    }

    let payload
    try {
      payload = await requestBody(input, init)
    } catch (error) {
      return errorResponse(`请求体解析失败：${error?.message || error}`, 400, CODES.invalidRequest)
    }

    if (wantsTools(payload)) {
      // 上游结构性拒绝 tools，提前说清而不是静默降级。
      return errorResponse(
        "CNB 的 Cookie 通道不支持工具调用（上游会回 403 Agent calls are not allowed）。" +
          "需要 tools 请把插件选项的 transport 设为 relay，指向一个 OpenAI 兼容中继。",
        501,
        CODES.notImplemented,
      )
    }

    const wantedStream = payload.stream === true
    const clean = cleanPayload(payload)
    const model = String(clean.model || DEFAULT_MODEL)

    let csrf = csrfkey
    if (!csrf) {
      // 只在缺的时候抓一次；失败不影响发请求（不带 csrfkey 的请求多数也能过）
      try {
        csrf = (await fetchCsrf({ session })).csrfkey
      } catch {
        csrf = ""
      }
    }

    /** 发一次上游。csrf 变化时要能重发，所以抽成函数。 */
    const send = (csrfValue) => {
      const cookies = [`CNBSESSION=${session}`]
      if (csrfValue) cookies.push(`csrfkey=${csrfValue}`)
      return fetch(`${WEB_BASE}/${repo}/-/ai/chat/completions`, {
        method: "POST",
        headers: baseHeaders({
          "content-type": "application/json",
          accept: wantedStream ? "text/event-stream" : "application/json",
          cookie: cookies.join("; "),
          origin: WEB_BASE,
          referer: `${WEB_BASE}/${repo}`,
          ...(csrfValue ? { csrftoken: csrfValue } : {}),
        }),
        body: JSON.stringify(clean),
        signal: init.signal ?? AbortSignal.timeout(300_000),
      })
    }

    let response
    try {
      response = await send(csrf)
      // 上游对 csrf 不匹配一律回 `401 Blocked by CSRF.` —— 那**不是**登录失效
      // （实测：真上游就是这个文案，仍然会带 401）。先补一次 csrf 重发，
      // 别让一次抓取失败把整个账号标成要重新登录。
      //
      // 实测（2026-11-02，真上游）：这条闸回的是 **401 `Blocked by CSRF.`**（JSON）；
      // 另一条路径会回 403 `csrf token mismatch`。两种都要补。
      // 重发**最多一次**：同一 CNBSESSION 连抓三次拿到的是同一个 csrfkey，
      // 所以 `fresh !== csrf` 这个条件本身就把重发限死在「缓存值确实过期」的场景。
      if (!response.ok && (response.status === 401 || response.status === 403)) {
        const peek = await response.clone().text().catch(() => "")
        if (/csrf/i.test(peek)) {
          const fresh = await fetchCsrf({ session }).then((r) => r.csrfkey).catch(() => "")
          if (fresh && fresh !== csrf) response = await send(fresh)
        }
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        return errorResponse(`等待 cnb.cool 响应超时（${repo}）`, 504, CODES.upstreamTimeout)
      }
      return errorResponse(`连不上 cnb.cool：${error?.message || error}`, 503, CODES.upstreamUnavailable)
    }

    const contentType = response.headers.get("content-type") || ""
    const htmlInstead = contentType.includes("text/html")
    if (!response.ok || htmlInstead) {
      const body = await readBody(response)
      const csrfBlocked = /csrf/i.test(errorText(body))
      const detail = htmlInstead
        ? `上游返回了 HTML（${response.status}）：那是 Cloudflare / 网关页，不是业务错误体。` +
          `最常见的原因是登录态已过期；仓库路径当前是 ${repo}。`
        : csrfBlocked
          ? `CNB 拒绝了这次请求（${response.status} Blocked by CSRF）：补了 csrf 令牌仍然不过，` +
            `说明这条 CNBSESSION 已经失效，请重新登录。仓库路径当前是 ${repo}。`
          : `CNB 上游 ${response.status}：${errorText(body)}`
      const loginBroken = isLoginBroken(response.status, body)
      const status = statusForCookie(response.status, { htmlInstead, loginBroken })
      return errorResponse(
        detail,
        status,
        loginBroken ? CODES.sessionExpired : codeForStatus(status),
        loginBroken ? { signIn: "expired" } : {},
      )
    }

    if (wantedStream) {
      // ⚠ 不要把流读掉 —— 原样交回去（HOOKS 坑 8：读了流，客户端只能看到第一段）
      return new Response(response.body, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
      })
    }

    let folded
    try {
      folded = await foldSse(response, model)
    } catch (error) {
      // 折叠失败＝上游的流不完整（提前结束 / 坏帧）。这属于「重试有意义」，
      // 按 ERROR-CODES R8 必须落 504 upstream_timeout，**不许**落 502。
      return errorResponse(
        `折叠上游 SSE 失败（流可能被截断）：${error?.message || error}`,
        504,
        CODES.upstreamTimeout,
      )
    }
    return jsonResponse(folded, 200, { "x-magpie-sign-in": "kept" })
  }
}

/**
 * relay 通道：直通一个 OpenAI 兼容中继（工具调用原生可用）。
 *
 * 这条通道**不碰 CNB 鉴权** —— 中继自己负责上游。插件只把 Authorization 换掉。
 */
export function buildRelayFetch({ options }) {
  const base = relayBase(options?.relay?.url)
  const key = String(options?.relay?.key || "")
  return async function relayFetch(input, init = {}) {
    const url = requestUrl(input)
    const incoming = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined) ?? {})
    const headers = baseHeaders({ "content-type": "application/json" })
    for (const [k, v] of incoming) {
      const lower = k.toLowerCase()
      // 这几个必须由我们决定：UA 决定能不能过 CF，authorization 是插件自己的 key
      if (["authorization", "host", "content-length", "user-agent", "cookie"].includes(lower)) continue
      headers[k] = v
    }
    if (key) headers.authorization = `Bearer ${key}`

    const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined)

    try {
      return await fetch(url, {
        method: init?.method ?? "POST",
        headers,
        body,
        signal: init?.signal ?? AbortSignal.timeout(300_000),
      })
    } catch (error) {
      if (error?.name === "AbortError") {
        return errorResponse(`等待中继 ${base} 响应超时`, 504, CODES.upstreamTimeout)
      }
      return errorResponse(`连不上中继 ${base}：${error?.message || error}`, 503, CODES.upstreamUnavailable)
    }
  }
}

/** 给 loader 用的完整返回值（`{ baseURL, apiKey, headers, fetch }`）。 */
export async function buildLoaderResult({ getAuth, options }) {
  const auth = await getAuth()
  if (!auth || !rawCredentialOf(auth)) return {}

  let account = resolveAccount(auth, options)
  // 档案里缺仓库路径 / 缺 session 就补一次探测（比如只粘了 CNBSESSION 的账号）
  if (!account.repo || !account.session) {
    try {
      await ensureCredential(auth, { options })
      account = resolveAccount(auth, options)
    } catch {
      /* 探测失败不阻塞：fetch 里会给出更准的错误 */
    }
  }

  const transport = pickTransport(account, options)
  if (transport === "relay") {
    return {
      baseURL: relayBase(options?.relay?.url),
      apiKey: String(options?.relay?.key || ""),
      headers: { "user-agent": baseHeaders()["user-agent"] },
      fetch: buildRelayFetch({ options }),
    }
  }
  if (transport === "cookie") {
    return {
      baseURL: `${WEB_BASE}/${account.repo}/-/ai`,
      // 鉴权走 cookie，这里只是个占位（SDK 会把它塞进 Authorization，我们不读）
      apiKey: "cnb-session",
      headers: { "user-agent": baseHeaders()["user-agent"] },
      fetch: buildCookieFetch({ getAuth, options }),
    }
  }

  // 走到这里只有一种情况：用户在选项里点名 `transport: "relay"` 却没填 relay.url。
  // ⚠ 绝不能返回 `{}` —— 那样宿主会拿 `provider.api`（https://cnb.cool）去拼一条根本
  //   不存在的 `/chat/completions`，用户看到的是一个迷惑的 404（2026-11-02 本机实测）。
  return {
    baseURL: WEB_BASE,
    apiKey: "cnb-none",
    headers: { "user-agent": baseHeaders()["user-agent"] },
    fetch: async () =>
      errorResponse(
        "插件选项里把 transport 设成了 relay，但 relay.url 是空的。" +
          "填一个 OpenAI 兼容中继的地址，或者把 transport 改回 auto（用 CNB 网页登录态直连）。",
        400,
        CODES.invalidRequest,
      ),
  }
}
