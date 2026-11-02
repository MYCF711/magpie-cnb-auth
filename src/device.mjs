// src/device.mjs —— OAuth Device Flow（RFC 8628），CNB 的「加账号」正路
//
// cnb-cli 的 `cnb login` 走的就是这一套（参数从 @cnbcool/cnb-cli 里读出来的，端点已实测）：
//
//   POST https://cnb.cool/oauth2/device/auth      client_id=cnb_cli
//     → { device_code, user_code, verification_uri, verification_uri_complete,
//         expires_in(≈600), interval(5) }
//   POST https://cnb.cool/oauth2/token
//     grant_type=urn:ietf:params:oauth:grant-type:device_code & device_code & client_id
//     → 200 token ／ 400 { error: authorization_pending | slow_down | access_denied | expired_token }
//   POST https://cnb.cool/oauth2/token
//     grant_type=refresh_token & refresh_token & client_id     ← 续期走这条
//
// 它**完全不碰** `~/.cnb/token`，所以可以反复登录不同账号 —— 这才是「添加账号」的正确姿势。
// （只读本机文件的那条路见 src/local-token.mjs，它只能读到那一个账号。）

import { OAUTH_CLIENT_ID, OAUTH_DEVICE_URL, OAUTH_TOKEN_URL, WEB_BASE } from "./context.mjs"
import { fetchUser, fetchTopGroups, listRepos } from "./api.mjs"
import { abortSignal, baseHeaders, readBody } from "./http.mjs"
import { pickRepo } from "./credential.mjs"

/** RFC 8628 设备码授权的 grant_type */
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

/** 设备码轮询的总预算，与 cnb-cli 一致 */
export const DEFAULT_MAX_WAIT_MS = 180_000

/** 可被 signal 中断的 sleep —— 用户取消登录时不能还挂在 setTimeout 上。 */
export function wait(ms, signal) {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(Object.assign(new Error("已取消授权"), { name: "AbortError" }))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort)
      resolve()
    }, ms)
    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener("abort", onAbort, { once: true })
    }
  })
}

/** 表单 POST —— OAuth 的两个端点都只吃 x-www-form-urlencoded。 */
export async function postForm(url, form, { signal, timeoutMs = 20_000 } = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: baseHeaders({ "content-type": "application/x-www-form-urlencoded" }),
    body: new URLSearchParams(form),
    signal: abortSignal(signal, timeoutMs),
  })
  const text = await response.text().catch(() => "")
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 留着文本给调用方 */
  }
  return { status: response.status, json, text: text.slice(0, 300) }
}

/** 申请设备码。失败的 message 会原样进 authorize 的错误里，所以带上 HTTP 状态。 */
export async function requestDeviceCode({ platform = WEB_BASE, clientId = OAUTH_CLIENT_ID, signal } = {}) {
  const base = String(platform || WEB_BASE).replace(/\/+$/, "")
  const res = await postForm(`${base}/oauth2/device/auth`, { client_id: clientId }, { signal })
  if (res.status !== 200 || !res.json?.device_code) {
    throw new Error(`申请设备授权失败（HTTP ${res.status}）：${res.json?.error_description || res.json?.error || res.text}`)
  }
  const dev = res.json
  return {
    platform: base,
    clientId,
    deviceCode: String(dev.device_code),
    userCode: String(dev.user_code || ""),
    verificationUri: String(dev.verification_uri || `${base}/oauth2/device/verify`),
    verificationUriComplete: String(dev.verification_uri_complete || `${base}/oauth2/device/verify?user_code=${dev.user_code}`),
    expiresIn: Number(dev.expires_in) || 600,
    interval: Number(dev.interval) > 0 ? Number(dev.interval) : 5,
  }
}

/** 轮询接口的四种「还没好」 —— 它们不是错误，是状态。 */
const DEVICE_ERRORS = {
  authorization_pending: "pending",
  slow_down: "slow",
  access_denied: "denied",
  expired_token: "expired",
}

/**
 * 轮询到用户完成授权为止。
 *
 * 总预算取 `min(maxWaitMs, expires_in)`。`slow_down` 按 RFC 8628 加 5 秒间隔，
 * 不是重试同一次 —— 这一点写错会被 CNB 当成刷接口。
 */
export async function pollDeviceToken(dev, { signal, maxWaitMs = DEFAULT_MAX_WAIT_MS } = {}) {
  const deadline = Date.now() + Math.min(maxWaitMs, dev.expiresIn * 1000)
  let interval = dev.interval * 1000

  while (Date.now() < deadline) {
    await wait(Math.min(interval, Math.max(0, deadline - Date.now())), signal)

    const res = await postForm(
      `${dev.platform}/oauth2/token`,
      { grant_type: DEVICE_GRANT, device_code: dev.deviceCode, client_id: dev.clientId },
      { signal },
    )
    if (res.status === 200 && res.json?.access_token) return res.json

    const code = DEVICE_ERRORS[res.json?.error]
    if (code === "pending") continue
    if (code === "slow") {
      interval += 5000
      continue
    }
    if (code === "denied") throw Object.assign(new Error("授权被拒绝"), { signIn: "expired" })
    if (code === "expired") throw new Error("设备码已过期，重新点一次登录即可")
    throw new Error(`token 请求失败（HTTP ${res.status}）：${res.json?.error_description || res.json?.error || res.text}`)
  }
  throw new Error("等待授权超时，重新点一次登录即可")
}

/**
 * 用 refresh_token 换新的 access_token。续期走这条，不是重新登录。
 *
 * 实测返回：`{ access_token, expires_in(≈28799), refresh_token, scope, token_type: "bearer" }`
 * 服务端可能轮换 refresh_token —— 没给就沿用旧的，别把它写成空串（铁律 3：返回的是合并）。
 */
export async function refreshAccessToken({ refresh, clientId = OAUTH_CLIENT_ID, signal, platform = WEB_BASE } = {}) {
  if (!refresh) return null
  const base = String(platform || WEB_BASE).replace(/\/+$/, "")
  const res = await postForm(
    `${base}/oauth2/token`,
    { grant_type: "refresh_token", refresh_token: String(refresh), client_id: String(clientId || OAUTH_CLIENT_ID) },
    { signal },
  ).catch((error) => {
    if (error?.name === "AbortError") throw error
    return { status: 0, json: null, text: String(error?.message || error) }
  })
  if (res.status >= 400 && (res.json?.error === "invalid_grant" || res.json?.error === "expired_token")) {
    throw Object.assign(new Error(`refresh_token 已失效：${res.json?.error_description || res.json.error}`), { signIn: "expired" })
  }
  const data = res.json
  if (res.status !== 200 || !data?.access_token) return null
  return {
    access: String(data.access_token),
    refresh: String(data.refresh_token || refresh),
    expires: Date.now() + (Number(data.expires_in) || 28_800) * 1000,
    clientId: String(data.client_id || clientId || OAUTH_CLIENT_ID),
  }
}

/**
 * 把「设备码登录」包成 magpie 要的 `authorize()` 返回值。
 *
 * ⚠ **`authorize()` 必须立刻返回**（铁律 2）：这里只申请设备码（一次很短的请求），
 *   真正的等待在 `callback()` 里。把轮询挪进 authorize 会和 magpie 双向死锁。
 *
 * ⚠ 登录成功后要顺手把 org / repo 探出来：AI 通道的 URL 需要仓库路径，
 *   探测失败不能阻塞登录（用户还能在选项里手填）。
 */
export async function loginViaDevice(options = {}, ctx = {}) {
  let dev
  try {
    dev = await requestDeviceCode({ platform: ctx.platform || WEB_BASE, clientId: ctx.clientId || OAUTH_CLIENT_ID, signal: ctx.signal })
  } catch (error) {
    return {
      url: `${WEB_BASE}/profile/token`,
      instructions: `${error?.message || error}。也可以改用「粘贴访问令牌」。`,
      method: "auto",
      async callback() {
        return { type: "failed", error: String(error?.message || error).slice(0, 400) }
      },
    }
  }

  return {
    url: dev.verificationUriComplete,
    instructions: dev.userCode
      ? `在打开的页面里确认授权（码 ${dev.userCode}），${Math.round(dev.expiresIn / 60)} 分钟内有效`
      : "在打开的页面里确认授权",
    method: "auto",
    opened: false,
    async callback() {
      let token
      try {
        token = await pollDeviceToken(dev, { signal: ctx.signal })
      } catch (error) {
        return { type: "failed", error: String(error?.message || error).slice(0, 400) }
      }

      const access = String(token.access_token)
      let user = null
      try {
        user = await fetchUser(access)
      } catch {
        user = null
      }
      if (!user) {
        return { type: "failed", error: "授权成功但读不到账号信息（/user 失败），稍后重试或改用「粘贴访问令牌」" }
      }

      const groups = await fetchTopGroups(access)
      const org = String(options.org || groups[0]?.path || "").replace(/^\/+|\/+$/g, "")
      const repos = org ? await listRepos(access, org) : []
      const repo = pickRepo(repos, "", { ...options, org })

      return {
        type: "success",
        access,
        refresh: String(token.refresh_token || ""),
        expires: Date.now() + (Number(token.expires_in) || 28_800) * 1000,
        accountId: user.username || "",
        uid: String(user.id || user.username || ""),
        // 下面这些是「AI 通道需要的上下文」，不是标准 auth 字段 —— magpie 会原样合并保存，
        // 续期时不许把它们清空（铁律 3）。
        org,
        repo,
        metadata: {
          org,
          repo,
          username: user.username || "",
          userId: String(user.id || ""),
          kind: "pat",
          clientId: dev.clientId,
          groups: groups.map((g) => g.path),
          loginMethod: "device",
        },
      }
    },
  }
}
