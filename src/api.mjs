// src/api.mjs —— 打 CNB 的那一层，只有这一层知道 CNB 长什么样
//
// CNB 有两个站，两套鉴权，**不能混用**：
//
//   api.cnb.cool   OpenAPI，`Authorization: Bearer <访问令牌>`：
//                  /user、/user/groups、/{org}/-/repos、/{org}/-/charge/*
//   cnb.cool       网页域，Cookie `CNBSESSION` + `Csrftoken`：
//                  AI 对话、以及没有公开 API 的网页侧动作
//
// 两者不通：拿 CNBSESSION 打 api.cnb.cool 会 401（它不吃 cookie），
// 拿 PAT 打网页 AI 端点会 403。所以「这个账号现在能干什么」由凭据种类决定，
// 而不是由配置决定 —— 见 src/credential.mjs。

import { API_BASE, WEB_BASE } from "./context.mjs"
import { abortSignal, baseHeaders, errorText, isLoginBroken, readBody, upstreamError } from "./http.mjs"

/** 默认超时：列表/资料类 15s，额度类 20s。没有超时的 fetch 会挂死整张卡片。 */
export const TIMEOUT = { short: 10_000, list: 15_000, quota: 20_000 }

/**
 * OpenAPI 请求。**PAT / `~/.cnb/token` 的 access_token 走这里。**
 *
 * 失败一律抛带 `status` 的异常；只有确认是登录问题才挂 `signIn: "expired"`。
 */
export async function cnbApi(path, { token, method = "GET", body, query, signal, timeoutMs = TIMEOUT.list } = {}) {
  if (!token) {
    const error = upstreamError("没有 CNB 访问令牌", 401)
    error.signIn = "expired"
    throw error
  }
  let url = `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`
  if (query && typeof query === "object") {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v))
    }
    const s = qs.toString()
    if (s) url += `${url.includes("?") ? "&" : "?"}${s}`
  }

  let response
  try {
    response = await fetch(url, {
      method,
      headers: baseHeaders({
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      }),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: abortSignal(signal, timeoutMs),
    })
  } catch (error) {
    if (error?.name === "AbortError") throw error
    throw upstreamError(`连不上 api.cnb.cool：${error?.message || error}`, 503)
  }

  const parsed = await readBody(response)
  if (!response.ok) {
    const error = upstreamError(`CNB API ${method} ${path} → ${response.status}：${errorText(parsed)}`, response.status)
    if (isLoginBroken(response.status, parsed)) error.signIn = "expired"
    throw error
  }
  return parsed
}

/** 用户详情：`username` 是卡片上要显示的名字，`id` 才是身份。 */
export async function fetchUser(token, { signal } = {}) {
  const data = await cnbApi("/user", { token, signal, timeoutMs: TIMEOUT.list })
  return data && typeof data === "object" ? data : null
}

/**
 * 顶级组织列表。
 * ⚠ 只粘了 CNBSESSION 的账号查不了这个（api.cnb.cool 不吃 cookie），
 *   所以调用方必须容忍它返回空数组，而不是把它当登录失败。
 */
export async function fetchTopGroups(token, { signal } = {}) {
  try {
    const data = await cnbApi("/user/groups", { token, query: { page: 1, page_size: 50 }, signal, timeoutMs: TIMEOUT.list })
    const list = Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : []
    return list
      .map((g) => ({
        path: String(g?.path || g?.slug || "").replace(/^\/+|\/+$/g, ""),
        name: String(g?.name || g?.path || ""),
        access: g?.access_role ?? null,
      }))
      .filter((g) => g.path)
  } catch {
    return []
  }
}

/**
 * 组织下可见仓库。
 *
 * ⚠ **仓库名不能靠猜**：`<org>/code` 猜错了，AI 请求会拿到一个 HTML 404，
 *   报错信息看起来像「登录过期」，实际只是路径不存在。
 */
export async function listRepos(token, org, { signal } = {}) {
  if (!org) return []
  try {
    const data = await cnbApi(`/${org}/-/repos`, { token, query: { page: 1, page_size: 50 }, signal, timeoutMs: TIMEOUT.list })
    const list = Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : []
    return list.map((r) => String(r?.path || r?.slug || r?.name || "").replace(/^\/+|\/+$/g, "")).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 在组织下建一个仓库。
 *
 * `POST /{group}/-/repos`，OpenAPI 要求访问令牌带 `group-resource:rw`。
 * **会改变用户账号**，所以只允许在「用户亲手点了登录、且组织里一个仓库都没有」时调用一次。
 *
 * 返回值刻意做成 `{ ok, status, body }` 而不抛 —— 建仓失败不该把一次成功的登录判成失败。
 */
export async function createRepo(token, org, name = "code", { description = "", signal } = {}) {
  if (!token || !org) return { ok: false, status: 0, body: { errmsg: "缺少访问令牌或组织" } }
  try {
    const response = await fetch(`${API_BASE}/${org}/-/repos`, {
      method: "POST",
      headers: baseHeaders({ authorization: `Bearer ${token}`, "content-type": "application/json" }),
      body: JSON.stringify({ name, description, visibility: "private" }),
      signal: abortSignal(signal, TIMEOUT.list),
    })
    const parsed = await readBody(response)
    return { ok: response.ok, status: response.status, body: parsed }
  } catch (error) {
    return { ok: false, status: 0, body: { errmsg: String(error?.message || error) } }
  }
}

/** 当月额度：`credit_in_milli.{free,total}`。单位是「毫 Credit」（1000 = 1 Credit）。 */
export function fetchQuota(token, org, { signal } = {}) {
  return cnbApi(`/${org}/-/charge/quota`, { token, signal, timeoutMs: TIMEOUT.quota })
}

/** 当月用量：`credit_in_milli` 是已用，`freeze_credit_in_milli` 是预扣。 */
export function fetchVolume(token, org, { signal } = {}) {
  return cnbApi(`/${org}/-/charge/volume`, { token, signal, timeoutMs: TIMEOUT.quota })
}

/**
 * 特权额度（高校 / 天才 / TDP 等认证带来的额外 Credit）。
 * 需要根组织权限，普通组织会 403 —— 所以调用方必须把它当「可选」。
 */
export function fetchSpecialAmount(token, org, { signal } = {}) {
  return cnbApi(`/${org}/-/charge/special-amount`, { token, signal, timeoutMs: TIMEOUT.quota })
}

/**
 * 网页侧请求（CNBSESSION + csrfkey）。**返回原始 Response**，由调用方决定怎么读。
 *
 * ⚠ Cookie 里必须同时带上 `csrfkey`（如果抓到了）并把它放进 `Csrftoken` 头，
 *   否则 CNB 会当成跨站请求直接回 `403 csrf token mismatch`。
 */
export async function cnbWeb(path, { session, csrfkey, method = "GET", body, signal, timeoutMs = TIMEOUT.list, csrfToken } = {}) {
  if (!session) {
    const error = upstreamError("缺少 CNBSESSION", 401)
    error.signIn = "expired"
    throw error
  }
  const cookies = [`CNBSESSION=${session}`]
  if (csrfkey) cookies.push(`csrfkey=${csrfkey}`)
  const url = path.startsWith("http") ? path : `${WEB_BASE}${path.startsWith("/") ? path : `/${path}`}`
  try {
    return await fetch(url, {
      method,
      headers: baseHeaders({
        cookie: cookies.join("; "),
        origin: WEB_BASE,
        referer: `${WEB_BASE}/`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(csrfToken ? { csrftoken: csrfToken } : {}),
      }),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: abortSignal(signal, timeoutMs),
    })
  } catch (error) {
    if (error?.name === "AbortError") throw error
    throw upstreamError(`连不上 cnb.cool：${error?.message || error}`, 503)
  }
}

/**
 * 抓一次首页，拿 csrftoken 与 csrfkey。
 *
 * ⚠ 这里**不做「登录了没有」的判断**。曾经用「首页 HTML > 200KB = 已登录」当判据，
 *   2026-11-02 实测把它证伪了：未登录的 `/` 是 145,452 字符，而**公开仓库页**
 *   `/cnb/docs/` 是 227,535 字符 —— 同一个阈值会把匿名访问判成已登录。
 *   登录有效性的真正判据只有一个：拿这条 CNBSESSION 去打 AI 端点，看上头怎么回
 *   （见 `src/chat.mjs` 的 `isLoginBroken()`）。这里只负责把 csrf 令牌取回来。
 */
export async function fetchCsrf({ session, signal } = {}) {
  const response = await cnbWeb("/", { session, signal, timeoutMs: TIMEOUT.list })
  const html = await response.text().catch(() => "")
  const csrfToken = html.match(/window\.csrftoken\s*=\s*"([0-9a-fA-F]+)"/)?.[1] || ""
  let csrfkey = ""
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const m = /(?:^|\s)csrfkey=([^;]+)/.exec(line)
    if (m) csrfkey = m[1]
  }
  if (!csrfkey) {
    const raw = response.headers.get("set-cookie") || ""
    const m = /(?:^|\s)csrfkey=([^;]+)/.exec(raw)
    if (m) csrfkey = m[1]
  }
  return { csrfToken, csrfkey, htmlLength: html.length }
}
