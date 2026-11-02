// src/checkin.mjs —— 每日签到
//
// CNB **没有**公开的「每日签到」接口。它给的是**每月**的 AI Credit
// （每月 1 日 UTC 重置）—— 所以默认答案是 `inactive`，不是「假装签了」。
//
// 想接自己的领取端点（社区里有人做了积分领取的包装），把选项里的
// `claim.url` 指过去即可：
//
//   claim: { url: "https://your-endpoint/claim", method: "POST", body: "{}" }
//
// 支持占位符 `{{org}}` / `{{repo}}` / `{{token}}`，请求会带上 `Authorization: Bearer <token>`。
//
// ⚠ 永远不要解验证码。端点回「要验证码」就返回 `captcha`，让用户去 CNB 站点自己签。
//   插件替用户解验证码，轻则被风控，重则把账号送走。

import { baseHeaders, errorText, readBody, upstreamError } from "./http.mjs"

/** outcome 只能这六个（HOOKS 二）。写别的，宿主会当成未知结果。 */
export const OUTCOMES = Object.freeze(["claimed", "done", "ineligible", "inactive", "captcha", "failed"])

function fill(template, { org, repo, token }) {
  return String(template || "")
    .replaceAll("{{org}}", org || "")
    .replaceAll("{{repo}}", repo || "")
    .replaceAll("{{token}}", token || "")
}

/** 从返回体里挖出签到结果。字段名不统一，所以按常见几种都认一遍。 */
export function interpretClaim(body, status = 200) {
  if (body?.captcha || body?.need_captcha) {
    return { outcome: "captcha", message: "领取端点要求验证码，请到 CNB 站点自己操作" }
  }
  const credit = body?.credit ?? body?.amount ?? body?.points
  const numeric = Number.isFinite(Number(credit)) ? Number(credit) : undefined
  const streak = body?.streak ?? body?.days
  const streakDays = Number.isFinite(Number(streak)) ? Number(streak) : undefined

  if (body?.already === true || body?.claimed === false) {
    return { outcome: "done", credit: numeric, message: String(body?.message || body?.msg || "今天已经领过了") }
  }
  if (Number(status) === 401 || Number(status) === 403) {
    return { outcome: "ineligible", message: errorText(body) || "这个账号没有领取资格" }
  }
  if (numeric === undefined && body?.ok === false) {
    return { outcome: "failed", message: errorText(body) || "领取失败" }
  }
  return {
    outcome: "claimed",
    credit: numeric,
    streak: streakDays,
    message: String(body?.message || body?.msg || "领取成功"),
  }
}

/**
 * 跑一次签到。
 *
 * @param {object} params
 * @param {object} params.options   归一化后的选项（读 `claim`）
 * @param {string} params.token     访问令牌（没有就只能是 inactive）
 * @param {string} params.org
 * @param {string} params.repo
 */
export async function doCheckin({ options, token, org, repo, signal } = {}) {
  const url = String(options?.claim?.url || "").trim()
  if (!url) {
    return {
      outcome: "inactive",
      message: "CNB 没有公开的每日签到接口；免费 AI Credit 是每月发放的（每月 1 日 UTC 重置）。",
    }
  }
  if (!token) {
    return {
      outcome: "ineligible",
      message: "领取端点要访问令牌，而这条账号只有 CNBSESSION。到 https://cnb.cool/profile/token 生成一个再粘进来。",
    }
  }

  const target = fill(url, { org, repo, token })
  const method = String(options?.claim?.method || "POST").toUpperCase()

  let payload = {}
  try {
    payload = JSON.parse(options?.claim?.body || "{}")
  } catch {
    payload = {}
  }

  let response
  try {
    response = await fetch(target, {
      method,
      headers: baseHeaders({ authorization: `Bearer ${token}`, "content-type": "application/json" }),
      body: method === "GET" ? undefined : JSON.stringify(payload),
      signal: signal ?? AbortSignal.timeout(20_000),
    })
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeout = upstreamError(`领取端点 ${target} 超时`, 504)
      return { outcome: "failed", message: timeout.message }
    }
    return { outcome: "failed", message: `领取请求失败：${error?.message || error}` }
  }

  const body = await readBody(response)
  if (response.status === 429) return { outcome: "failed", message: "领取端点被限流，稍后重试" }
  if (!response.ok && response.status !== 401 && response.status !== 403) {
    return { outcome: "failed", message: `HTTP ${response.status}：${errorText(body)}` }
  }
  return interpretClaim(body, response.status)
}
