// src/badges.mjs —— 认证徽章：把「你在这个站上是谁」翻译成一枚标签
//
// 数据源只有一处真的接口：`GET /user` 的 `identity_providers`。
//
// ⚠ `/user/identity`、`/user/ext_identity`、`/user/charge/ext_identity/privilege`
//   是**控制台页面**，不是 API —— 参考实现只把它们当链接写进 UI，从不请求。
//   这里同样不请求：任何关于它们响应体的说法都是臆测。
//
// 兜底：`identity_providers` 为 null 时，从特权额度的 `credit_desc` 文字里认。
// 必要性有实测依据 —— 一个明确拥有「天才程序员专属特权」的账号，`identity_providers`
// 也可能返回 null。

/** 高校身份标签。键是 CNB 前端 i18n 里的 `EXT_IDENTITY_*` 对应的枚举值。 */
export const EDU_LABELS = Object.freeze({
  STUDENT: "高校学生",
  TEACHER: "高校老师",
  ALUMNI: "高校校友",
  STAFF: "高校职工",
  ENTERPRISE: "高校合作企业",
  ORGANIZATION: "高校开放实验室",
})

/** 「天才 + 高校」合并后的标签：不显示两枚，合并成「天才X」。 */
export const GENIUS_EDU_LABELS = Object.freeze({
  STUDENT: "天才学生",
  TEACHER: "天才老师",
  ALUMNI: "天才校友",
  STAFF: "天才职工",
  ENTERPRISE: "天才合作企业",
  ORGANIZATION: "天才开放实验室",
})

export const GENIUS_BADGE = "天才程序员"

/**
 * 从 `/user` 的返回里算出徽章。
 *
 * `identity_providers` 是**对象字典**：键存在就代表拥有该身份
 * （`genius` / `obt_player` / `day_one_player` 用「键存在」判断），
 * `edu.identity_type` 是大写枚举字符串，`tdp.tdp_primary_tag` 是任意字符串。
 *
 * @param {object} user `GET /user` 的返回
 * @returns {{label:string,key:string,kind:string,tone:string,tooltip?:string}[]}
 */
export function badgesFromUser(user) {
  const providers = user?.identity_providers && typeof user.identity_providers === "object" ? user.identity_providers : {}
  const eduRaw = providers.edu?.identity_type
  const eduType = typeof eduRaw === "string" ? eduRaw.toUpperCase() : ""
  const hasGenius = Object.prototype.hasOwnProperty.call(providers, "genius")
  const hasEdu = Boolean(eduType)
  const hasObt = Object.prototype.hasOwnProperty.call(providers, "obt_player")
  const hasDayOne = Object.prototype.hasOwnProperty.call(providers, "day_one_player")
  const tdpTag = providers.tdp?.tdp_primary_tag

  const badges = []
  if (hasObt) badges.push({ key: "obt_player", label: "内测玩家", kind: "player", tone: "info" })
  if (hasDayOne) badges.push({ key: "day_one_player", label: "开服玩家", kind: "player", tone: "info" })

  if (hasGenius) {
    // 天才 + 高校 合并成一枚，而不是显示两枚
    const label = hasEdu ? GENIUS_EDU_LABELS[eduType] || GENIUS_BADGE : GENIUS_BADGE
    badges.push({
      key: hasEdu ? "genius+edu" : "genius",
      label,
      kind: hasEdu ? "combined" : "genius",
      tone: "success",
      tooltip: hasEdu ? `${GENIUS_BADGE} + ${EDU_LABELS[eduType] || "高校认证"}` : GENIUS_BADGE,
    })
  } else if (hasEdu) {
    badges.push({
      key: "edu",
      label: EDU_LABELS[eduType] || "高校认证",
      kind: "edu",
      tone: "success",
      tooltip: `高校师生 · ${eduType}`,
    })
  }

  if (typeof tdpTag === "string" && tdpTag.trim()) {
    badges.push({ key: "tdp", label: `TDP ${tdpTag.trim()}`, kind: "tdp", tone: "success" })
  }

  return badges
}

/**
 * 兜底：从特权额度的说明文字里认身份。
 *
 * 去重规则：已经有同 `kind`（或已有 combined）就不再补 ——
 * 否则一个「天才程序员」会既有一枚来自 /user 的、又有一枚来自 credit_desc 的。
 */
export function badgesFromCreditDesc(desc, existing = []) {
  const text = String(desc || "")
  if (!text.trim()) return existing
  const kinds = new Set(existing.map((b) => b.kind))
  const out = [...existing]
  const add = (badge) => {
    if (kinds.has(badge.kind) || kinds.has("combined")) return
    kinds.add(badge.kind)
    out.push({ ...badge, source: "特权额度说明" })
  }
  if (/天才/.test(text)) add({ key: "genius", label: GENIUS_BADGE, kind: "genius", tone: "success" })
  if (/高校/.test(text)) add({ key: "edu", label: "高校认证", kind: "edu", tone: "success" })
  if (/TDP/i.test(text)) add({ key: "tdp", label: "TDP 会员", kind: "tdp", tone: "success" })
  return out
}

/** 一组徽章 → 卡片 plan 那一行的文字。没有徽章时退回「免费额度」。 */
export function planOf(badges) {
  const labels = (badges || []).map((b) => b.label).filter(Boolean)
  return labels.length ? labels.join(" · ") : "CNB 免费额度"
}
