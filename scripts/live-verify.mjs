#!/usr/bin/env node
/**
 * live-verify —— **真打上游**的验证，不是单测。
 *
 * `tests/` 全是离线的（伪造 fetch），锁得住形状，锁不住「上游到底怎么回」。
 * 这一份只回答一件事：代码里关于 CNB 的那些假设，在真实上游上成不成立。
 *
 * 五组检查：
 *   1 设备码 OAuth   POST https://cnb.cool/oauth2/device/auth（**不完成授权**，只轮询到超时）
 *   2 PAT 通道       GET  https://api.cnb.cool/user（假令牌）→ 插件把它归成哪一类
 *   3 Cookie 通道    GET  https://cnb.cool/<公开仓库>/ 取 csrfkey
 *                    → POST https://cnb.cool/<repo>/-/ai/chat/completions（假 CNBSESSION）
 *                    → 断言 CSRF 重发**恰好一次**、不会无限重试
 *   4 relay 通道     本机 node:http 起一个假 OpenAI 中继，经 buildLoaderResult() 的 fetch
 *                    端到端跑 tools / 非流式 / 流式 三种请求
 *   5 九钩子装配     import index.mjs → CnbAuthPlugin({}, {}) 的形状 + authorize() 的返回时延
 *
 * 跑法：
 *   node scripts/live-verify.mjs
 *
 * 退出码：0 = 五项全过；1 = 有失败（逐条打印真实错误，不吞）。
 *
 * 边界（务必读完再改这份脚本）：
 *   · 只用**明显的假值**（FAKE_PAT / FAKE_SESSION），日志里显示为 <FAKE>；
 *     真实 csrfkey / csrftoken 只打印长度，不打印值 —— 跑完仍要 `node scripts/privacy-scan.mjs`。
 *   · 不写任何文件、不碰 ~/.config/magpie、不装插件、不重启任何进程、**不完成 OAuth 授权**。
 *   · 每个真实请求 ≤20s 超时。网络级抖动（连接被断、DNS、超时）由 runOne() 让**整项检查**
 *     重跑一次，并在重跑前清空计数 —— 所以日志里的「上游 POST 2 次」不会被重试放大成 4 次。
 *     4xx/5xx 是上游的真实回答，**不重试**。
 *   · relay 服务只监听 127.0.0.1 的随机端口，跑完立即 close。
 *
 * 已知的演化点：上游文案会变，断言尽量只锁「类别」不锁「句子」。
 * 唯一锁死的字符串是 `authorization_pending`（它是 RFC 8628 的协议值，不是文案）。
 */

import http from "node:http"

import { CnbAuthPlugin } from "../index.mjs"
import {
  API_BASE,
  OAUTH_CLIENT_ID,
  OAUTH_DEVICE_URL,
  OAUTH_TOKEN_URL,
  PROVIDER,
  USER_AGENT,
  WEB_BASE,
} from "../src/context.mjs"
import { DEVICE_GRANT, pollDeviceToken, requestDeviceCode } from "../src/device.mjs"
import { fetchCsrf, fetchUser } from "../src/api.mjs"
import { buildCookieFetch, buildLoaderResult, codeForStatus, foldSse, statusForUpstream } from "../src/chat.mjs"
import { normaliseOptions } from "../src/options.mjs"
import { clearCredentialCache, identifyCredential } from "../src/credential.mjs"
import { CODES, baseHeaders, isLoginBroken } from "../src/http.mjs"

// ─────────────────────────────────────────────────────────────────────
// 0. 常量：一个真仓库、两个假凭据、一个超时
// ─────────────────────────────────────────────────────────────────────

/**
 * 真实存在的公开仓库（2026-11-02 实测：GET 返回 200 + text/html + Set-Cookie: csrfkey）。
 * 它的作用只是「让 csrfkey 从一个真页面里来」，不参与任何断言；路径写错另有 case c/case e 专门验。
 */
const PUBLIC_REPO = "cnb/docs"

/** 不存在的仓库路径：case c 记录真实现象，case e 用它取真实 403 响应体验映射。 */
const BOGUS_REPO = "cnb/no-such-repo-live-probe"

/**
 * 假访问令牌：完全随机的一串，没有任何真前缀。
 * 故意**不带** `cnb_at_` 前缀 —— 带的话就分不清「上游拒的是令牌」还是「上游拒的是前缀」。
 */
const FAKE_PAT = "fake-pat-for-live-probe"

/**
 * 假 CNBSESSION：形状必须真的像（三段 `数字.数字.<hex≥16>`），
 * 否则 `src/credential.mjs` 的 `shapeKind()` 会判成 unknown，走不到 cookie 通道。
 * 内容本身是垃圾（两个 10 位数字 + 32 个 f），不可能对应任何真实会话。
 */
const FAKE_SESSION = ["1700000000", "1700000000", "f".repeat(32)].join(".")

/** 一个「上次会话留下来的」陈旧 csrfkey —— 用来触发 src/chat.mjs 的 CSRF 重发分支。 */
const STALE_CSRF = "stale-csrf-for-live-probe"

/** 日志里所有假凭据统一显示成这个。 */
const FAKE = "<FAKE>"

/** 单次真实请求的超时上限（任务要求 ≤20s）。 */
const TIMEOUT_MS = 20_000

/**
 * `src/device.mjs:86-91` 的 DEVICE_ERRORS 的键（那张表没导出，这里按源码镜像一份）。
 * 改那边就要改这里 —— 否则这组断言会变成「验一张不存在的表」。
 */
const DEVICE_STATUS_KEYS = ["authorization_pending", "slow_down", "access_denied", "expired_token"]

// ─────────────────────────────────────────────────────────────────────
// 1. 基础设施：fetch 计数、探针、小工具
// ─────────────────────────────────────────────────────────────────────

/** 未打补丁的真 fetch —— 我自己发的探针走这条，不污染插件的调用计数。 */
const realFetch = globalThis.fetch.bind(globalThis)

/**
 * 插件的每一次真实出网都记在这里。
 *
 * 为什么能这么数：`src/` 里所有调用点写的都是裸 `fetch(...)`（运行时查全局），
 * 所以换掉 `globalThis.fetch` 就能一颗不漏地数到，而且不用改 `src/`。
 */
const HITS = []

/** 装上计数补丁。返回卸载函数。 */
function installFetchProbe() {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input)
    const method = String(init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    let host = ""
    let path = ""
    try {
      const u = new URL(url)
      host = u.hostname
      path = u.pathname
    } catch {
      /* 非 http(s)，不计 */
    }
    HITS.push({ host, path, method })
    return realFetch(input, init)
  }
  return () => {
    globalThis.fetch = realFetch
  }
}

/** 数命中：`path` 按「包含」匹配，因为插件的路径里带仓库名。 */
function countHits({ host, method, path } = {}) {
  return HITS.filter(
    (h) => (!host || h.host === host) && (!method || h.method === method) && (!path || h.path.includes(path)),
  ).length
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 一个真请求：自带超时，把 body 读完，尽量给 JSON。 */
async function probe(url, init = {}) {
  const response = await realFetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS) })
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 非 JSON 就留着 text */
  }
  return { status: response.status, contentType: response.headers.get("content-type") || "", headers: response.headers, text, json }
}

function safeJson(text) {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

const fmt = (value) => (typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? String(value))

/** 一个检查的收集器：证据照记，问题不抛 —— 保证「失败也把真实错误打全」。 */
function collector() {
  const evidence = []
  const problems = []
  return {
    evidence,
    problems,
    note(text) {
      evidence.push(text)
    },
    expect(cond, msg) {
      if (!cond) problems.push(String(msg))
    },
    eq(actual, expected, msg) {
      if (actual !== expected) problems.push(`${msg}：实际 ${fmt(actual)}，预期 ${fmt(expected)}`)
    },
    /** 只判类别：`pattern.test(String(actual))`。 */
    match(actual, pattern, msg) {
      if (!pattern.test(String(actual ?? ""))) problems.push(`${msg}：实际 ${fmt(actual)}`)
    },
  }
}

/** 网络级抖动才算「可重试」；HTTP 4xx/5xx 是上游的回答，不是抖动。 */
function isTransient(error) {
  const name = String(error?.name || "")
  if (name === "AbortError" || name === "TimeoutError") return true
  const text = `${error?.message || ""} ${error?.cause?.code || ""} ${error?.cause?.message || ""}`
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|other side closed/i.test(text)
}

// ─────────────────────────────────────────────────────────────────────
// 2. 五项检查
// ─────────────────────────────────────────────────────────────────────

/**
 * ① 设备码 OAuth —— RFC 8628 的前两步，**不走到第三步**（不完成授权）。
 *
 * 判据四件事：
 *   a. 原样复刻 src/device.mjs 的参数，真实端点回 200；
 *   b. 响应里 device_code / user_code / verification_uri(_complete) / expires_in / interval 都在；
 *   c. 代码真的读得到它们（`requestDeviceCode()` 归一化后的字段非空且合理）；
 *   d. 轮询语义：`authorization_pending` 被当成「还没好」继续轮，且总预算到点就退出。
 */
async function checkDeviceFlow() {
  const c = collector()

  // a. 原样复刻 src/device.mjs:48-63 的请求：表单 POST + baseHeaders（含 UA）
  const raw = await probe(OAUTH_DEVICE_URL, {
    method: "POST",
    headers: baseHeaders({ "content-type": "application/x-www-form-urlencoded" }),
    body: new URLSearchParams({ client_id: OAUTH_CLIENT_ID }),
  })
  const body = raw.json || {}
  const keys = Object.keys(body)
  c.note(`原样 POST ${OAUTH_DEVICE_URL}（client_id=${OAUTH_CLIENT_ID}）→ HTTP ${raw.status} · ${raw.contentType}`)
  c.note(`响应字段：${keys.length ? keys.join(", ") : "(空)"}`)
  c.eq(raw.status, 200, "设备码申请")

  // b. 代码读的字段必须都在
  const required = ["device_code", "user_code", "verification_uri", "verification_uri_complete", "expires_in", "interval"]
  const missing = required.filter((k) => body[k] === undefined || body[k] === null || body[k] === "")
  c.expect(missing.length === 0, `设备码响应里缺字段：${missing.join(", ") || "(无)"}`)

  // 「代码读不到的字段」点名 —— 任务要求写进报告
  const notRead = keys.filter((k) => !required.includes(k))
  c.note(`代码不读的字段：${notRead.length ? notRead.map((k) => `${k}=${JSON.stringify(body[k])}`).join(", ") : "(无)"}`)

  // c. 走一遍代码自己的解析
  const dev = await requestDeviceCode({ signal: AbortSignal.timeout(TIMEOUT_MS) })
  c.note(
    `requestDeviceCode() → platform=${dev.platform} · clientId=${dev.clientId} · ` +
      // user_code 也是一次性的真实凭据，日志里只给长度
      `userCode=<user_code ${dev.userCode.length} 位> · ` +
      `deviceCode=${dev.deviceCode.slice(0, 7)}…(len ${dev.deviceCode.length}) · expiresIn=${dev.expiresIn} · interval=${dev.interval}`,
  )
  c.expect(dev.deviceCode.length === String(body.device_code || "").length, "deviceCode 与原始 device_code 不一致")
  c.match(dev.deviceCode, /^cnb_dc_/, "deviceCode 前缀")
  c.expect(dev.userCode.length > 0, "userCode 为空")
  // 用 expect 而不是 match：match 失败时会把实际值（含 user_code）打进日志
  c.expect(
    dev.verificationUriComplete.includes(`user_code=${dev.userCode}`),
    "verification_uri_complete 里没有带上 user_code",
  )
  c.expect(Number(dev.expiresIn) > 0 && Number(dev.interval) > 0, "expiresIn / interval 必须为正数")

  // d. 轮询语义：第一次轮询应当明确说「还没授权」
  const poll = await probe(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: baseHeaders({ "content-type": "application/x-www-form-urlencoded" }),
    body: new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: dev.deviceCode, client_id: dev.clientId }),
  })
  const pollError = String(poll.json?.error || "")
  c.note(`POST ${OAUTH_TOKEN_URL}（轮询一次）→ HTTP ${poll.status} · error=${pollError || "(无)"}`)
  c.eq(poll.status, 400, "尚未授权的轮询状态码")
  c.expect(
    DEVICE_STATUS_KEYS.includes(pollError),
    `轮询返回的 error=${fmt(pollError)} 不在 src/device.mjs 的 DEVICE_ERRORS 里（${DEVICE_STATUS_KEYS.join(" / ")}）`,
  )

  // d2. 让代码自己轮一遍：预算 6s，应当耗尽预算后抛「等待授权超时」，而不是一直挂着
  HITS.length = 0
  const startedAt = Date.now()
  let loopError = null
  try {
    await pollDeviceToken(dev, { maxWaitMs: 6_000 })
  } catch (error) {
    loopError = error
  }
  const elapsed = Date.now() - startedAt
  const polls = countHits({ host: "cnb.cool", method: "POST", path: "/oauth2/token" })
  c.note(`pollDeviceToken(maxWaitMs=6000) → ${polls} 次轮询 · ${elapsed}ms 后退出：${loopError?.message ?? "(没抛错)"}`)
  c.match(loopError?.message, /等待授权超时/, "预算耗尽后应当抛「等待授权超时」")
  c.expect(elapsed >= 5_000 && elapsed <= 12_000, `轮询总耗时 ${elapsed}ms，预期 5~12s（间隔 5s、预算 6s）`)
  c.expect(polls >= 1 && polls <= 3, `轮询次数 ${polls}，预期 1~3（pending 继续、到点退出）`)

  return c
}

/**
 * ② PAT 通道 —— 假令牌打真 OpenAPI，看插件把它归成哪一类。
 *
 * 判据：必须归成「登录失效」（401 + signIn:expired），不能归成 404 / 模型不可用 / 502。
 * 判错的后果见 AGENTS.md 坑 6：401 会 failover 到每一个账号，404 只搁置模型。
 */
async function checkPatChannel() {
  const c = collector()

  // a. 真实状态码与响应体形状
  const raw = await probe(`${API_BASE}/user`, { headers: baseHeaders({ authorization: `Bearer ${FAKE_PAT}` }) })
  const shape = raw.json ? Object.entries(raw.json).map(([k, v]) => `${k}:${Array.isArray(v) ? "array" : typeof v}`).join(", ") : "(非 JSON)"
  c.note(`GET ${API_BASE}/user（Bearer ${FAKE}）→ HTTP ${raw.status} · ${raw.contentType}`)
  c.note(`响应体形状：{ ${shape} } · 原文：${raw.text.replace(/\s+/g, " ").slice(0, 120)}`)
  c.eq(raw.status, 401, "假令牌访问 /user 的状态码")
  c.expect(raw.contentType.includes("application/json"), `响应不是 JSON（${raw.contentType}）`)

  // b. 插件侧映射
  let userError = null
  try {
    await fetchUser(FAKE_PAT, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (error) {
    userError = error
  }
  c.note(`fetchUser() 抛出 → status=${userError?.status ?? "(无)"} · signIn=${userError?.signIn ?? "(无)"}`)
  c.expect(userError !== null, "fetchUser() 对假令牌没有抛错（它只应该抛）")
  c.eq(userError?.status, 401, "插件映射的 status")
  c.eq(userError?.signIn, "expired", "插件映射的 signIn 标记")
  // 错误信息必须留上游原文，否则用户和日志都不知道上游说了什么
  c.match(userError?.message, /401/, "错误信息里丢了 HTTP 状态")
  c.match(userError?.message, /not logged in/i, "错误信息里丢了上游 errmsg 原文")

  // c. 不误判：401 必须被判成「登录问题」
  c.eq(isLoginBroken(raw.status, raw.json), true, "isLoginBroken(401, 真实响应体) 应当为 true")

  // d. 凭据识别：假 PAT 应当被明确拒绝，并说清「你给的是什么」
  clearCredentialCache()
  let idError = null
  try {
    await identifyCredential(FAKE_PAT, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (error) {
    idError = error
  }
  c.note(`identifyCredential() 抛出 → status=${idError?.status ?? "(无)"} · signIn=${idError?.signIn ?? "(无)"}`)
  c.expect(idError !== null, "identifyCredential() 对假 PAT 没有抛错")
  c.eq(idError?.status, 401, "凭据识别的 status")
  c.eq(idError?.signIn, "expired", "凭据识别的 signIn")
  c.match(idError?.message, /粘贴的凭证无效/, "凭据识别没说清「你给的是什么」")
  c.expect(idError?.status !== 404, "假令牌被误判成 404（会只搁置模型，掩掉真问题）")

  return c
}

/**
 * ③ Cookie 通道 —— 假 CNBSESSION 走真实网页域。
 *
 * 五个 case，每个都数上游调用次数：
 *   a. 账号里没有 csrfkey（最常见：刚粘完 CNBSESSION）→ 插件自己抓一次 csrf，再发一次
 *   b. 账号里带着一个陈旧 csrfkey → 401 + Blocked by CSRF → 抓新 csrf → **重发一次**
 *      这一条是「CSRF 重发最多一次」的直接证据：上游 POST 恰好 2 次
 *   c. 仓库路径写错 → 记录真实状态码（这套假凭据下 CSRF 闸先于仓库鉴权回答）
 *   d. 带 tools → 在发上游之前就返回 501，0 次网络
 *   e. 上游真实 403 响应体 → 走插件自己的映射函数，验证「路径写错不改标账号失效」
 */
async function checkCookieChannel() {
  const c = collector()

  // ① 真实公开仓库页取 csrfkey（原样请求，不走插件，避免污染调用计数）
  const pageHeaders = baseHeaders({ accept: "text/html" })
  pageHeaders["cookie"] = "CNBSESSION=" + FAKE_SESSION
  const page = await probe(`${WEB_BASE}/${PUBLIC_REPO}/`, { headers: pageHeaders })
  const setCookies = page.headers.getSetCookie?.() ?? []
  const cookieHeaders = setCookies.length ? setCookies.join(" | ") : page.headers.get("set-cookie") || ""
  const csrfkey = /(?:^|\s)csrfkey=([^;]+)/.exec(cookieHeaders)?.[1] || ""
  const htmlChars = page.text.length
  const htmlBytes = Buffer.byteLength(page.text, "utf8")
  c.note(
    `GET ${WEB_BASE}/${PUBLIC_REPO}/ → HTTP ${page.status} · ${page.contentType} · ${htmlBytes} 字节 / ${htmlChars} 字符`,
  )
  c.note(`Set-Cookie 里的 csrfkey：${csrfkey ? `有（长度 ${csrfkey.length}，值不打印）` : "没有"}`)
  c.expect(page.status === 200, `公开仓库页返回 HTTP ${page.status}（这个仓库可能已不公开，换 PUBLIC_REPO）`)
  c.expect(csrfkey !== "", "取不到 csrfkey —— 真实现象，记录下来而不是编一个")
  c.note(`HTML 里 window.csrftoken：${/window\.csrftoken\s*=\s*"/.test(page.text) ? "有" : "没有"}`)

  // 插件自己的 csrf 抓取打的是 "/"，不是仓库页 —— 顺手验证解析器可用
  const fetched = await fetchCsrf({ session: FAKE_SESSION, signal: AbortSignal.timeout(TIMEOUT_MS) })
  c.note(
    `fetchCsrf()（打 "/"）→ csrfkey ${fetched.csrfkey ? `有(长度 ${fetched.csrfkey.length})` : "没有"} · ` +
      `csrfToken ${fetched.csrfToken ? "有" : "没有"} · htmlLength=${fetched.htmlLength} · looksLoggedIn=${fetched.looksLoggedIn}`,
  )
  c.expect(fetched.csrfkey !== "", 'fetchCsrf() 没从首页 "/" 解析出 csrfkey')

  const aiUrl = `${WEB_BASE}/${PUBLIC_REPO}/-/ai/chat/completions`
  const plainBody = JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "ping" }] })

  /** 跑一次 buildCookieFetch，返回响应 + 这一次的上游计数。 */
  async function runCase({ auth, options, body = plainBody, url = aiUrl }) {
    clearCredentialCache()
    HITS.length = 0
    const cookieFetch = buildCookieFetch({ getAuth: async () => auth, options: normaliseOptions(options) })
    const response = await cookieFetch(url, { method: "POST", body, signal: AbortSignal.timeout(TIMEOUT_MS) })
    const text = await response.text()
    return {
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      signIn: response.headers.get("x-magpie-sign-in"),
      json: safeJson(text),
      text,
      posts: countHits({ host: "cnb.cool", method: "POST", path: "/-/ai/chat/completions" }),
      csrfGets: countHits({ host: "cnb.cool", method: "GET" }),
      total: HITS.length,
    }
  }

  // ── case a：没有缓存 csrfkey ──
  const a = await runCase({ auth: { type: "api", key: FAKE_SESSION }, options: { repo: PUBLIC_REPO } })
  c.note(
    `case a（无缓存 csrfkey）→ HTTP ${a.status} · ${a.contentType} · 是 HTML=${a.contentType.includes("text/html")} · ` +
      `x-magpie-sign-in=${a.signIn ?? "(无)"} · code=${a.json?.error?.code ?? "(无)"} · ` +
      `上游 POST ${a.posts} 次 / 抓 csrf ${a.csrfGets} 次`,
  )
  c.eq(a.status, 401, "假 CNBSESSION 的映射状态码")
  c.eq(a.json?.error?.code, CODES.sessionExpired, "假 CNBSESSION 的错误码")
  c.eq(a.signIn, "expired", "假 CNBSESSION 的登录失效标记")
  c.expect(a.contentType.includes("application/json"), `cookie 通道错误体不是 JSON（${a.contentType}）`)
  c.expect(a.posts >= 1 && a.posts <= 2, `case a 上游 POST ${a.posts} 次，预期 1~2`)

  // ── case b：陈旧 csrfkey → 必须**恰好**重发一次 ──
  const b = await runCase({
    auth: { type: "api", key: FAKE_SESSION, metadata: { csrfkey: STALE_CSRF, kind: "session" } },
    options: { repo: PUBLIC_REPO },
  })
  c.note(
    `case b（陈旧 csrfkey=${STALE_CSRF}）→ HTTP ${b.status} · x-magpie-sign-in=${b.signIn ?? "(无)"} · ` +
      `code=${b.json?.error?.code ?? "(无)"} · 上游 POST ${b.posts} 次（首次 + 重发）`,
  )
  c.eq(b.status, 401, "重发一次后仍然是 401")
  c.eq(b.json?.error?.code, CODES.sessionExpired, "重发一次后的错误码")
  c.eq(b.signIn, "expired", "重发一次后的登录失效标记")
  c.eq(b.posts, 2, "CSRF 重发次数（首次 + 最多一次重发 = 2 次上游 POST，不会无限重试）")

  // ── case c：仓库路径写错 ──
  //
  // ⚠ 实测结论：带任何 csrfkey 的请求会被 CSRF 闸先拦下（401 Blocked by CSRF.），
  //   仓库鉴权那一步在这套假凭据下**不可达**。所以这里记录真实现象，
  //   「路径写错的 403 怎么映射」放到 case e 单独验证。
  const d = await runCase({ auth: { type: "api", key: FAKE_SESSION }, options: { repo: BOGUS_REPO } })
  c.note(
    `case c（仓库路径 ${BOGUS_REPO}）→ HTTP ${d.status} · code=${d.json?.error?.code ?? "(无)"} · ` +
      `x-magpie-sign-in=${d.signIn ?? "(无)"} · 上游 POST ${d.posts} 次 · 是 HTML=${d.contentType.includes("text/html")}`,
  )
  c.note("    ↑ 假 CNBSESSION 下 CSRF 闸先回答，路径写错的分支不可达；路径那条见 case e")
  c.eq(d.status, 401, "case c 的真实行为（CSRF 闸优先，落登录失效）")
  c.eq(d.json?.error?.code, CODES.sessionExpired, "case c 的错误码")

  // ── case d：带 tools → 发请求之前就拒绝 ──
  const toolsBody = JSON.stringify({
    model: "deepseek-v4.1-flash",
    stream: true,
    messages: [{ role: "user", content: "ping" }],
    tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: {} } } }],
  })
  const e = await runCase({ auth: { type: "api", key: FAKE_SESSION }, options: { repo: PUBLIC_REPO }, body: toolsBody })
  c.note(`case d（带 tools）→ HTTP ${e.status} · code=${e.json?.error?.code ?? "(无)"} · 上游调用 ${e.total} 次`)
  c.eq(e.status, 501, "cookie 通道带 tools 的状态码")
  c.eq(e.json?.error?.code, CODES.notImplemented, "cookie 通道带 tools 的错误码")
  c.eq(e.total, 0, "带 tools 的请求必须在出网之前就返回 501（0 次上游调用）")

  // ── case e：真实 403 响应体 → 插件的映射 ──
  //
  // 不带 csrfkey 时上游才走到仓库鉴权，回 403 {"errcode":7,"errmsg":"User has no permission."}。
  // 这一条不是端到端（插件总会带 csrfkey），但响应体与映射函数都是真的。
  const forbidHeaders = baseHeaders({ "content-type": "application/json", origin: WEB_BASE, referer: `${WEB_BASE}/${BOGUS_REPO}` })
  forbidHeaders["cookie"] = "CNBSESSION=" + FAKE_SESSION
  const forbid = await probe(`${WEB_BASE}/${BOGUS_REPO}/-/ai/chat/completions`, {
    method: "POST",
    headers: forbidHeaders,
    body: JSON.stringify({ model: "deepseek-v4.1-flash", stream: true, messages: [{ role: "user", content: "ping" }] }),
  })
  const mapped = statusForUpstream(forbid.status)
  const mappedCode = codeForStatus(mapped)
  c.note(
    `case e（不带 csrfkey，才走到仓库鉴权）→ 上游 HTTP ${forbid.status} · ${forbid.contentType} · 体 ${forbid.text.replace(/\s+/g, " ").slice(0, 90)}`,
  )
  c.note(
    `case e 映射 → isLoginBroken=${isLoginBroken(forbid.status, forbid.json)} · statusForUpstream(403)=${mapped} · codeForStatus=${mappedCode}`,
  )
  c.eq(forbid.status, 403, "路径写错时上游的状态码")
  c.eq(isLoginBroken(forbid.status, forbid.json), false, "403 但不提登录 → 不许标账号登录失效")
  c.eq(mapped, 502, "403 的宿主状态码（不该是 401）")
  c.eq(mappedCode, CODES.upstreamError, "403 的错误码")

  return c
}

// ─────────────────────────────────────────────────────────────────────
// ③-附：本机假 relay（只回固定内容，专门用来验证 relay 通道的透传语义）
// ─────────────────────────────────────────────────────────────────────

const STREAM_PARTS = ["中继", "分段", "内容"]
const NON_STREAM_TEXT = "relay-non-stream-ok"
const RELAY_USAGE = { prompt_tokens: 21, completion_tokens: 5, total_tokens: 26 }

function chunkFrame(model, text, index) {
  return {
    id: "chatcmpl-relay-sse",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model,
    choices: [
      {
        index: 0,
        delta: index === 0 ? { role: "assistant", content: text } : { content: text },
        finish_reason: index === STREAM_PARTS.length - 1 ? "stop" : null,
      },
    ],
  }
}

/** 起一个假 OpenAI 兼容中继。返回 { url, seen, close }。 */
async function startRelay() {
  const seen = []
  const server = http.createServer((req, res) => {
    let raw = ""
    req.setEncoding("utf8")
    req.on("data", (chunk) => {
      raw += chunk
    })
    req.on("end", async () => {
      const body = safeJson(raw)
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })

      const model = String(body?.model || "")
      const tools = Array.isArray(body?.tools) ? body.tools : []

      // ① 流式：三帧 + 一个 usage 帧（choices: []）+ [DONE]，帧之间留 40ms 证明是真流
      if (body?.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" })
        for (let i = 0; i < STREAM_PARTS.length; i++) {
          res.write(`data: ${JSON.stringify(chunkFrame(model, STREAM_PARTS[i], i))}\n\n`)
          await sleep(40)
        }
        res.write(
          `data: ${JSON.stringify({ id: "chatcmpl-relay-sse", object: "chat.completion.chunk", model, choices: [], usage: RELAY_USAGE })}\n\n`,
        )
        res.end("data: [DONE]\n\n")
        return
      }

      // ② 带 tools：回一个 tool_calls，工具名照抄收到的第一个 —— 便于断言「原样转发」
      if (tools.length > 0) {
        const name = String(tools[0]?.function?.name || "")
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
        res.end(
          JSON.stringify({
            id: "chatcmpl-relay-tools",
            object: "chat.completion",
            created: 1_700_000_000,
            model,
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    { id: "call_relay_1", type: "function", function: { name, arguments: '{"city":"Hangzhou"}' } },
                  ],
                },
              },
            ],
            usage: RELAY_USAGE,
          }),
        )
        return
      }

      // ③ 普通一次性响应
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
      res.end(
        JSON.stringify({
          id: "chatcmpl-relay-plain",
          object: "chat.completion",
          created: 1_700_000_000,
          model,
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: NON_STREAM_TEXT } }],
          usage: RELAY_USAGE,
        }),
      )
    })
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const { port } = server.address()
  return {
    // 带 /v1：顺手验证 relayBase() 会不会把 `/v1` 剥掉
    url: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * ④ relay 通道 —— 端到端三种请求，全部断言 relay 实际收到的内容。
 *
 * 关键点：relay 通道是**直通**（src/chat.mjs:264-295 原样返回上游 Response），
 * 所以「SSE 折叠」这条能力靠 `foldSse()` 单独验证 —— 它是 cookie 通道用的同一段代码。
 */
async function checkRelayChannel() {
  const c = collector()
  const relay = await startRelay()

  try {
    const options = normaliseOptions({ repo: PUBLIC_REPO, relay: { url: relay.url } })
    const getAuth = async () => ({ type: "api", key: FAKE_SESSION })
    const loader = await buildLoaderResult({ getAuth, options })

    c.expect(typeof loader.fetch === "function", "buildLoaderResult() 没给出 fetch（transport 没选到 relay）")
    c.eq(loader.baseURL, `http://127.0.0.1:${new URL(relay.url).port}`, "baseURL 应当去掉 /v1 与尾斜杠")
    c.eq(loader.apiKey, "", "没配 relay.key 时 apiKey 应当是空串")
    c.note(`buildLoaderResult() → baseURL=${loader.baseURL} · apiKey=${loader.apiKey ? "<KEY>" : '""'} · fetch=function`)

    const endpoint = `${loader.baseURL}/chat/completions`
    const clientHeaders = {
      "content-type": "application/json",
      // 下面两个是「客户端塞进来、relay 通道必须换掉/剥掉」的头
      authorization: "Bearer client-token-should-be-stripped",
      "user-agent": "client-ua-should-be-replaced",
      "x-live-probe": "relay-passthrough",
    }

    // ── ① 带 tools：必须原样转发到 relay ──
    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "查天气",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      },
    ]
    const toolsBody = {
      model: "deepseek-v4.1-flash",
      stream: false,
      messages: [{ role: "user", content: "杭州天气" }],
      tools,
      tool_choice: "auto",
    }
    const toolsRes = await loader.fetch(endpoint, {
      method: "POST",
      headers: clientHeaders,
      body: JSON.stringify(toolsBody),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const toolsJson = safeJson(await toolsRes.text())
    const toolsHit = relay.seen.at(-1) || {}

    c.note(
      `① tools → relay 收到 HTTP ${toolsHit.method} ${toolsHit.url} · tools=${Array.isArray(toolsHit.body?.tools) ? toolsHit.body.tools.length : 0} 条 · ` +
        `回包 finish_reason=${toolsJson?.choices?.[0]?.finish_reason} · tool_calls[0]=${toolsJson?.choices?.[0]?.message?.tool_calls?.[0]?.function?.name}`,
    )
    c.eq(toolsHit.url, "/chat/completions", "relay 收到的路径")
    c.eq(JSON.stringify(toolsHit.body?.tools), JSON.stringify(tools), "tools 必须原样到达 relay（不能删、不能改）")
    c.eq(toolsHit.body?.tool_choice, "auto", "tool_choice 必须原样到达 relay")
    c.eq(toolsHit.headers?.["x-live-probe"], "relay-passthrough", "自定义头应当透传")
    c.eq(toolsHit.headers?.authorization, undefined, "客户端带来的 authorization 必须被剥掉")
    c.eq(toolsHit.headers?.["user-agent"], USER_AGENT, "user-agent 必须换成插件自己的")
    c.eq(toolsJson?.choices?.[0]?.message?.tool_calls?.[0]?.function?.name, "get_weather", "relay 的 tool_calls 要回到客户端")

    // ── ② 非流式：拿到一次性 chat.completion ──
    const plainRes = await loader.fetch(endpoint, {
      method: "POST",
      headers: clientHeaders,
      body: JSON.stringify({ model: "deepseek-v4.1-flash", stream: false, messages: [{ role: "user", content: "ping" }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const plainText = await plainRes.text()
    const plainJson = safeJson(plainText)
    c.note(
      `② 非流式 → HTTP ${plainRes.status} · ${plainRes.headers.get("content-type")} · object=${plainJson?.object} · content=${plainJson?.choices?.[0]?.message?.content}`,
    )
    c.eq(plainJson?.object, "chat.completion", "非流式请求的返回类型")
    c.eq(plainJson?.choices?.[0]?.message?.content, NON_STREAM_TEXT, "非流式内容")
    c.expect(!plainText.includes("data:"), "非流式响应里不应该有 SSE 帧")

    // ── ②b SSE 折叠：cookie 通道用的同一段代码（src/chat.mjs 的 foldSse → src/openai-sse.mjs） ──
    const sseRes = await loader.fetch(endpoint, {
      method: "POST",
      headers: clientHeaders,
      body: JSON.stringify({ model: "deepseek-v4.1-flash", stream: true, messages: [{ role: "user", content: "ping" }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    c.eq(sseRes.bodyUsed, false, "折叠前流必须还没被读过")
    const folded = await foldSse(sseRes, "deepseek-v4.1-flash")
    c.note(
      `②b foldSse → object=${folded.object} · choices=${folded.choices?.length} · content=${folded.choices?.[0]?.message?.content} · ` +
        `finish=${folded.choices?.[0]?.finish_reason} · usage.total_tokens=${folded.usage?.total_tokens}`,
    )
    c.eq(folded.object, "chat.completion", "折叠结果的类型")
    c.eq(folded.choices?.length, 1, "折叠结果只能有一条 choice")
    c.eq(folded.choices?.[0]?.message?.content, STREAM_PARTS.join(""), "折叠后的内容必须是所有帧拼起来的")
    c.eq(folded.usage?.total_tokens, RELAY_USAGE.total_tokens, "usage 帧（choices: []）也要保留")

    // ── ③ 流式：原样透出、不读干 ──
    const streamRes = await loader.fetch(endpoint, {
      method: "POST",
      headers: clientHeaders,
      body: JSON.stringify({ model: "deepseek-v4.1-flash", stream: true, messages: [{ role: "user", content: "ping" }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const notDrained = streamRes.bodyUsed === false
    const streamText = await streamRes.text()
    const dataLines = streamText.split(/\r?\n/).filter((line) => line.startsWith("data:"))
    c.note(
      `③ 流式 → HTTP ${streamRes.status} · ${streamRes.headers.get("content-type")} · ` +
        `交回时 bodyUsed=${notDrained ? "false（流还没被读过，透传正确）" : "true（已被读掉，透传失败）"} · ` +
        `读到 ${dataLines.length} 个 data 帧（含 [DONE]）· 末帧=${dataLines.at(-1)?.slice(0, 24)}`,
    )
    c.eq(streamRes.status, 200, "流式状态码")
    c.match(streamRes.headers.get("content-type"), /text\/event-stream/, "流式的 content-type")
    c.eq(notDrained, true, "流式响应在交回客户端时必须还没被读过（读了客户端只能看到第一段）")
    c.eq(dataLines.length, STREAM_PARTS.length + 2, "data 帧数（3 个内容帧 + usage 帧 + [DONE]）")
    c.match(dataLines.at(-1), /\[DONE\]/, "最后一帧")
    for (const part of STREAM_PARTS) c.expect(streamText.includes(part), `流里缺了分段「${part}」`)

    c.eq(relay.seen.length, 4, "relay 一共应当收到 4 个请求（tools / 非流式 / 折叠用流式 / 透传用流式）")
  } finally {
    await relay.close()
  }

  return c
}

/**
 * ⑤ 九钩子装配 —— 只验形状与时延，不验业务。
 *
 * `authorize()` 的判据是**时延**（< 2000ms）与「不轮询」：
 * 设备码流程不请求一次 device/auth 就拿不到 user_code，所以这里允许最多 1 次短请求，
 * 但要记下来 —— 报告里会点名它和「不发起网络」的说法不一致。
 */
async function checkHooks() {
  const c = collector()
  const plugin = await CnbAuthPlugin({}, {})

  c.eq(typeof plugin.config, "function", "config 钩子")
  c.eq(typeof plugin.auth?.refresh, "function", "auth.refresh 钩子")
  c.eq(typeof plugin.auth?.loader, "function", "auth.loader 钩子")
  c.eq(typeof plugin.auth?.usage, "function", "auth.usage 钩子")
  c.eq(typeof plugin.auth?.checkin, "function", "auth.checkin 钩子")
  c.eq(typeof plugin.provider?.models, "function", "provider.models 钩子")
  c.eq(typeof plugin["chat.headers"], "function", '"chat.headers" 钩子')
  c.eq(plugin.auth?.provider, PROVIDER, "auth.provider")
  c.eq(plugin.provider?.id, PROVIDER, "provider.id")

  // config({}) → 必须有模型（铁律 1：未登录也要有）
  const cfg = {}
  await plugin.config(cfg)
  const declared = cfg.provider?.[PROVIDER]
  const modelIds = Object.keys(declared?.models || {})
  c.note(`config({}) → provider.${PROVIDER} · npm=${declared?.npm} · models=${modelIds.length} 条（${modelIds.slice(0, 3).join(", ")}…）`)
  c.expect(declared !== undefined, `config({}) 没有声明 provider.${PROVIDER}`)
  c.expect(modelIds.length > 0, "config({}) 之后模型表是空的（铁律 1）")
  c.eq(declared?.npm, "@ai-sdk/openai-compatible", "SDK 形状")

  // 三条登录方式
  const methods = plugin.auth?.methods
  c.expect(Array.isArray(methods) && methods.length === 3, `auth.methods 应当 3 条，实际 ${methods?.length}`)
  const [device, local, paste] = methods || []
  c.eq(device?.type, "oauth", "第 1 条登录方式类型")
  c.eq(typeof device?.authorize, "function", "第 1 条登录方式要有 authorize")
  c.eq(local?.type, "oauth", "第 2 条登录方式类型")
  c.eq(typeof local?.authorize, "function", "第 2 条登录方式要有 authorize")
  c.eq(paste?.type, "api", "第 3 条登录方式类型")
  c.eq(paste?.authorize, undefined, "第 3 条（粘贴）不许有 authorize —— 输入框的值进不来")
  c.eq(paste?.prompts, undefined, "第 3 条（粘贴）不许有 prompts")
  c.expect(typeof paste?.placeholder === "string" && paste.placeholder.length > 0, "粘贴方式要有 placeholder")
  c.note(`auth.methods → [${methods?.map((m) => `${m.type}:${m.label ?? m.placeholder?.slice(0, 8) ?? ""}`).join(" | ")}]`)

  if (typeof device?.authorize === "function") {
    HITS.length = 0
    const startedAt = Date.now()
    const start = await device.authorize()
    const elapsed = Date.now() - startedAt
    const requests = HITS.slice()
    const polls = countHits({ host: "cnb.cool", method: "POST", path: "/oauth2/token" })
    c.note(
      `第 1 条 authorize() → ${elapsed}ms · 出网 ${requests.length} 次（${requests.map((h) => `${h.method} ${h.path}`).join(", ") || "无"}）· 轮询 ${polls} 次`,
    )
    c.expect(elapsed < 2_000, `第 1 条 authorize() 用了 ${elapsed}ms（必须 < 2000ms）`)
    c.eq(polls, 0, "authorize() 里不许轮询 token（轮询必须留在 callback）")
    c.expect(requests.length <= 1, `authorize() 出了 ${requests.length} 次网，预期 ≤1（只有设备码申请这一步）`)
    c.match(start?.url, /\/oauth2\/device\/verify/, "authorize() 返回的 url")
    c.expect(typeof start?.instructions === "string" && start.instructions.length > 0, "authorize() 要有 instructions")
    c.eq(start?.method, "auto", "authorize() 的 method")
    c.eq(typeof start?.callback, "function", "authorize() 要给 callback")
  }

  if (typeof local?.authorize === "function") {
    HITS.length = 0
    const startedAt = Date.now()
    const start = await local.authorize()
    const elapsed = Date.now() - startedAt
    c.note(`第 2 条 authorize() → ${elapsed}ms · 出网 ${HITS.length} 次`)
    c.expect(elapsed < 2_000, `第 2 条 authorize() 用了 ${elapsed}ms`)
    c.eq(HITS.length, 0, "第 2 条 authorize() 只读本机文件，不许出网")
    c.eq(typeof start?.callback, "function", "第 2 条要有 callback")
  }

  return c
}

// ─────────────────────────────────────────────────────────────────────
// 3. 执行与汇总
// ─────────────────────────────────────────────────────────────────────

const CHECKS = [
  { no: 1, name: "设备码 OAuth", run: checkDeviceFlow },
  { no: 2, name: "PAT 通道", run: checkPatChannel },
  { no: 3, name: "Cookie 通道", run: checkCookieChannel },
  { no: 4, name: "relay 通道", run: checkRelayChannel },
  { no: 5, name: "九钩子装配", run: checkHooks },
]

/** 跑一个检查：网络级抖动重试一次；HTTP 结果不重试（那会把计数证据弄脏）。 */
async function runOne(check) {
  let lastError = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    HITS.length = 0
    const startedAt = Date.now()
    try {
      const result = await check.run()
      return { ...check, ok: result.problems.length === 0, evidence: result.evidence, problems: result.problems, ms: Date.now() - startedAt, attempt }
    } catch (error) {
      lastError = error
      if (!isTransient(error) || attempt === 2) break
      await sleep(600)
    }
  }
  return {
    ...check,
    ok: false,
    evidence: [],
    problems: [
      `检查本身抛了异常（${lastError?.name || "Error"}）：${lastError?.message || lastError}` +
        (lastError?.cause?.code ? ` · cause=${lastError.cause.code}` : ""),
    ],
    ms: 0,
    attempt: 2,
  }
}

const now = new Date()
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`

console.log("live-verify —— 真打上游的验证（不是单测）")
console.log(`日期 ${today} · node ${process.version} · 上游 ${WEB_BASE} / ${API_BASE} · 仓库页 ${PUBLIC_REPO}`)
console.log("凭据一律用假值（日志里显示为 <FAKE>），不完成任何授权，不写任何文件。")
console.log("")

const uninstall = installFetchProbe()
let results = []
try {
  for (const check of CHECKS) {
    const result = await runOne(check)
    results.push(result)
    const mark = result.ok ? "✓" : "✗"
    const head = result.evidence[0] ?? "(没有证据)"
    console.log(`${mark} ${result.no} ${result.name} — ${head}${result.attempt > 1 ? " · 重试后成功" : ""}`)
    for (const line of result.evidence.slice(1)) console.log(`    · ${line}`)
    for (const problem of result.problems) console.log(`    ✗ ${problem}`)
    console.log("")
  }
} finally {
  uninstall()
}

const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
console.log(`通过 ${passed} · 失败 ${failed}`)
if (failed > 0) console.log(`失败的项：${results.filter((r) => !r.ok).map((r) => `${r.no} ${r.name}`).join(" · ")}`)
process.exit(failed > 0 ? 1 : 0)
