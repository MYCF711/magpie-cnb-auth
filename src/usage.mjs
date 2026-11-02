// src/usage.mjs —— 额度：把 CNB 的三个接口拼成 magpie 的额度卡片
//
// CNB 免费层是**按月发的 AI Credit**（每月 1 日 UTC 重置），不是「每天签到领」。
// 三个接口各管一段，缺一个就只能显示一部分：
//
//   GET /{org}/-/charge/quota           当月额度   credit_in_milli.{free,total}
//   GET /{org}/-/charge/volume          当月用量   credit_in_milli（已用）、freeze_credit_in_milli（预扣）
//   GET /{org}/-/charge/special-amount  特权额度   credit / credit_desc / credit_expire（需根组织权限）
//
// 单位是「毫 Credit」：1000 = 1 Credit。
//
// ⚠ 窗口对象一律用 src/quota.mjs 的构造器，不要自己拼 —— 它把「写错不报错、
//   但 GUI 和智能路由会坏」的写法变成运行时错误（AGENTS 坑 22 / 24）。

import { usage as quotaUsage, usageWindow } from "./quota.mjs"
import { CODES, upstreamError } from "./http.mjs"
import { fetchQuota, fetchSpecialAmount, fetchUser, fetchVolume } from "./api.mjs"
import { badgesFromCreditDesc, badgesFromUser } from "./badges.mjs"

/** 上游的「毫 Credit」→ Credit，保留两位小数。`null` / 空串必须保持 `null`（不能变成 0）。 */
export function milliToCredit(milli) {
  if (milli === null || milli === undefined || milli === "") return null
  const n = Number(milli)
  if (!Number.isFinite(n)) return null
  return Math.round(n / 10) / 100
}

/** 只有有限数字才算读数；`null` / `undefined` / `""` 一律当「没给」。 */
export function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * 下一次重置时间：**下月 1 日 0 点 UTC**。
 *
 * ⚠ 必须是 ISO 字符串。塞厂商原样时间（`"2026-11-01 00:00:00"`）会让整条窗口被丢掉
 * （AGENTS 坑 22），卡片上就只剩「剩余额度未知」。
 */
export function nextMonthReset(now = new Date()) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0))
  return next.toISOString()
}

/** 把三个接口的原始返回拼成一份读数。字段缺失一律 `null`，不猜。 */
export function buildCreditView(quota, volume, special) {
  const total = milliToCredit(numberOrNull(quota?.credit_in_milli?.total))
  const free = milliToCredit(numberOrNull(quota?.credit_in_milli?.free))
  const used = milliToCredit(numberOrNull(volume?.credit_in_milli))
  const frozen = milliToCredit(numberOrNull(volume?.freeze_credit_in_milli))

  // 「特权」= 总量里不是免费额度的那部分。两个数都拿到才算，否则 null。
  const privilege = total !== null && free !== null ? Math.round((total - free) * 100) / 100 : null
  const specialCredit = numberOrNull(special?.credit)

  return {
    total,
    free,
    used,
    frozen,
    privilege,
    special: specialCredit,
    specialDesc: String(special?.credit_desc || ""),
    specialExpire: String(special?.credit_expire || ""),
    unit: "credits",
    resetsAt: nextMonthReset(),
  }
}

/** 通道说人话。用在「AI 通道」那一行 —— 别等用户发消息才炸。 */
export function describeTransport(transport) {
  if (transport === "relay") return "中继机（支持 tools）"
  if (transport === "cookie") return "Cookie 直连（可用）"
  return "缺 CNBSESSION，点「粘贴访问令牌」补上"
}

function credits(n) {
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })
}

/**
 * 把读数拼成 `usage()` 的返回值。
 *
 * 三种结果，各自对应不同的诚实度：
 *   ① 有 total + used   → 占比型窗口，路由会计入这个号（这是唯一「参与排序」的形态）
 *   ② 只有 free         → 钱包型窗口（只显示余额，没有上限可算）
 *   ③ 一个数都没有      → **返回 error + 空窗口**，不伪造 0%（伪造会让空号排到路由队首）
 *
 * ⚠ 窗口里**必须至少有一条带 used / balance**，否则 src/quota.mjs 的 `usage()` 会抛：
 *   全是 aside / textOnly 时，这个号在路由页等于不存在（AGENTS 坑 24）。
 */
export function buildUsage({ credit, badges = [], transport = "none", username = "", org = "" }) {
  const windows = []
  const plan = (badges || []).map((b) => b.label).filter(Boolean).join(" · ") || "CNB 免费额度"

  let routable = false

  if (credit.total !== null && credit.used !== null) {
    windows.push(
      usageWindow({
        name: "AI Credit（当月）",
        amount: credit.used,
        limit: credit.total,
        unit: "credits",
        resetsAt: credit.resetsAt,
        display: `已用 ${credits(credit.used)} / 总 ${credits(credit.total)} credits`,
      }),
    )
    routable = true
  } else if (credit.free !== null) {
    windows.push(
      usageWindow({
        name: "免费 AI Credit（当月）",
        balance: credit.free,
        unit: "credits",
        resetsAt: credit.resetsAt,
        display: `${credits(credit.free)} credits`,
      }),
    )
    routable = true
  }

  // 认证特权额度：用光也不停账号，所以是 aside（只上卡片，不参与路由）
  if (credit.special !== null && credit.special > 0) {
    windows.push(
      usageWindow({
        name: "认证特权额度",
        used: 0,
        aside: true,
        display: `${credits(credit.special)} credits${credit.specialDesc ? ` — ${credit.specialDesc}` : ""}`,
        ...(credit.specialExpire ? { runsOutAt: credit.specialExpire } : {}),
      }),
    )
  }

  // AI 通道状态：告诉用户「现在这条通道能不能发消息」，不用等到报错
  windows.push(
    usageWindow({
      name: "AI 通道",
      used: 0,
      aside: true,
      display: describeTransport(transport),
    }),
  )

  if (!routable) {
    return {
      plan,
      user: username,
      error:
        "额度接口没返回可用的数字：可能是组织的 slug 不对（当前 " +
        `${org || "未探测到"}），或者这条账号只有 CNBSESSION、没有访问令牌 —— ` +
        "额度必须用访问令牌查（到 https://cnb.cool/profile/token 生成一个再粘进来）。",
      windows: [],
    }
  }

  // 过一遍构造器：窗口写法错会**当场抛**，而不是变成「GUI 显示不对但日志里什么都没有」。
  return quotaUsage({
    plan,
    user: username,
    ...(credit.total !== null ? { balance: `${credits(credit.total)} credits` } : {}),
    windows,
  })
}

/**
 * 拉一次额度。**PAT / 访问令牌才能查** —— CNBSESSION 打不了 api.cnb.cool。
 *
 * 三个接口的失败策略不一样，别一刀切：
 *   额度 / 用量失败 → 抛（没有它就没有读数）
 *   特权额度失败   → 吞掉（普通组织本来就没权限，403 是正常的）
 */
export async function fetchUsageSnapshot({ token, org, signal } = {}) {
  if (!token) {
    const error = upstreamError(
      "额度需要访问令牌：CNBSESSION 只能跑 AI 通道，查不了 api.cnb.cool。" +
        "到 https://cnb.cool/profile/token 生成一个再「粘贴访问令牌」补上。",
      401,
    )
    error.code = CODES.signInRequired
    throw error
  }
  if (!org) {
    const error = upstreamError("没有探测到组织（org）：额度是按组织算的，先重新登录一次或直接在选项里填 org。", 400)
    error.code = CODES.invalidRequest
    throw error
  }

  const [quota, volume] = await Promise.all([
    fetchQuota(token, org, { signal }),
    fetchVolume(token, org, { signal }).catch(() => null),
  ])
  let special = null
  try {
    special = await fetchSpecialAmount(token, org, { signal })
  } catch {
    special = null
  }
  return buildCreditView(quota, volume, special)
}

/**
 * 一次拿全卡片要的东西：账号名 + 认证徽章 + 当月 Credit。
 *
 * 徽章来自 `GET /user` 的 `identity_providers`；拿不到时用特权额度的
 * `credit_desc` 文字兜底（实测：有「天才程序员专属特权」的账号也可能返回 null）。
 * `/user` 失败**不影响**额度 —— 只是没有徽章，别为了一枚标签把整张卡片弄成错误。
 */
export async function fetchAccountSnapshot({ token, org, signal } = {}) {
  const credit = await fetchUsageSnapshot({ token, org, signal })
  const user = await fetchUser(token, { signal }).catch(() => null)
  let badges = user ? badgesFromUser(user) : []
  badges = badgesFromCreditDesc(credit.specialDesc, badges)
  return { user, badges, credit }
}
