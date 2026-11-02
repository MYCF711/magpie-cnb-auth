// src/account-name.mjs —— 卡片上那个账号名从哪来
//
// ═══════════════════════════════════════════════════════════════════
// 问题
// ═══════════════════════════════════════════════════════════════════
//
// OAuth 换码的响应里通常**没有**账号名（Accio / 多数国内厂商都一样）。于是卡片只能显示
// 「Signed in」或者供应商名 —— 用户看不出这是哪个号，多账号时更明显。
//
// 解法：凭据拿到之后，立刻调一个「读当前账号」的接口，把手机号 / 邮箱塞进 `accountId`。
//
// ═══════════════════════════════════════════════════════════════════
// 四条规矩
// ═══════════════════════════════════════════════════════════════════
//
// ① **失败不能阻塞登录**：取不到账号名只是显示问题，登录本身已经成功。
//    `accountId` 留空串 → magpie 回退到供应商名（HOOKS 八的三级回退），不编造。
// ② **优先级固定**：手机号 → 邮箱 → 用户 id → 空串。手机号要**打码**
//    （`0086-13800138000` / `+86 138 0013 8000` / `13800138000` 一律 `138****8000`），
//    和别的供应商一致。**只有去掉国家码后 ≥11 位的才算手机号**；7–10 位短号返回空串，
//    让调用方回退到邮箱/空名 —— 否则 `1234567` 会被打成 `123****4567`，原号码全部数字都在里面。
// ③ **别把 `accountId` 当唯一键**：它是给人看的；区分同名账号靠 `uid`（HOOKS 八）。
// ④ **内部 ID 不是名字**：`iam::<domain>:user:<name>`、`urn:…`、uuid、裸 hash、
//    华为 IAM 的 `hw000000000000000` —— 这些都是**身份**，写进 `accountId` 就永久留在
//    卡片上（续期与合并都会原样保留），用户看到的是三串看不懂的 ID。它们进 `uid`。
//
//    反例（真实事故，CodeArts 0.2.4）：卡片的账号名取了 refresh token 里的
//    `principal_urn`，三个账号显示成 `iam::00000000…:user:hw0000…` 三行，用户以为是乱码，
//    而那串 ID 从没被换掉过。修法是登录后读一次 IAM 的手机号 —— 见 `resolveAccount`。

/** 手机号打码成 `138****8000`：厂商给 `0086-1…`、`+86 1…`、已打码的，都认。 */
export function maskPhone(raw) {
  const text = String(raw ?? "").trim()
  // 已经是 `138****8000` 这种形状：不能再按数字串处理（去掉 * 后只剩 7 位）。
  // 允许带国家码/空格前缀（厂商的 maskedMobile 常给 `+86 138****8000`）。
  const compact = text.replace(/\s+/g, "")
  const stripped = compact.replace(/^(?:\+?86|0086)/, "")
  if (/^\d{3}\*{4}\d{4}$/.test(stripped)) return stripped

  let digits = text.replace(/\D/g, "")
  // 国家码只有「0086 + 11 位」或「86 + 11 位」时才剥。不能无条件剥：
  // 11 位、本身以 86 开头的号码（86123456789）会被误砍成 9 位，卡片就没名字了。
  if (digits.startsWith("0086")) {
    if (digits.length !== 15) return ""
    digits = digits.slice(4)
  } else if (digits.startsWith("86") && digits.length === 13) {
    digits = digits.slice(2)
  }
  // 短号打码会把原号码全部暴露（7 位 → 前 3 + 后 4 就是全部），返回空串让调用方回退。
  if (digits.length < 11) return ""
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`
}

// 「这看起来是 ID，不是名字」。判据都是**能一眼看出**的形状，不做语义猜测：
const IDENTIFIER_PATTERNS = [
  /::/, // iam::<domain>:user:<name> / arn:…:…
  /^urn:/i, // urn:…
  /^hw[0-9a-z]{8,}$/i, // 华为 IAM 的账号名：hw000000000000000
  /^[0-9a-f]{8}-[0-9a-f]{4}-/i, // uuid
  /^[0-9a-f]{16,}$/i, // 裸 hash / 32 位 domain id
]

/** 这个值像「内部 ID」吗？像就不该当名字显示。 */
export function looksLikeIdentifier(v) {
  const s = String(v ?? "").trim()
  if (!s) return false
  return IDENTIFIER_PATTERNS.some((re) => re.test(s))
}

/**
 * 从「当前账号」接口的响应里挑一个给人看的名字。
 *
 * @param {object|null} info 接口返回的用户对象
 * @param {object} [o]
 * @param {string[]} [o.mobile] 手机号字段名（按优先级）
 * @param {string[]} [o.email]  邮箱字段名（按优先级）
 * @param {string[]} [o.id]     id 字段名（最后兜底）
 * @param {RegExp} [o.strip]   不打码时要去掉的前缀（默认去掉 `+86 `）
 * @param {boolean} [o.mask]   手机号是否打码，默认 `true`（规矩 ②）
 * @param {boolean} [o.allowId] 允许 `id` 兜底里像内部 ID 的值，默认 `false`（规矩 ④）
 */
export function accountLabelOf(info, o = {}) {
  if (!info || typeof info !== "object") return ""
  const mobileKeys = o.mobile ?? ["maskedMobile", "mobile", "phone", "phoneNumber"]
  const emailKeys = o.email ?? ["email", "desensitizedEmail", "mail"]
  const idKeys = o.id ?? ["userId", "username", "name", "accountId"]
  const strip = o.strip ?? /^\+?86\s*/
  const mask = o.mask ?? true
  const allowId = o.allowId ?? false

  for (const k of mobileKeys) {
    const v = String(info[k] ?? "").trim()
    if (!v) continue
    if (mask) {
      const masked = maskPhone(v)
      // 不是 11 位手机号 → 跳过这个字段（**不能**退回原值，否则短号会原样上卡片）
      if (masked) return masked
      continue
    }
    return v.replace(strip, "")
  }
  for (const k of emailKeys) {
    const v = String(info[k] ?? "").trim()
    if (v) return v
  }
  for (const k of idKeys) {
    const v = String(info[k] ?? "").trim()
    if (v && (allowId || !looksLikeIdentifier(v))) return v
  }
  return ""
}

/**
 * 包一层：调接口取账号名，失败就 `log` 一句并返回空串。
 * 让 callback 里只写一行 `accountId: await resolveAccountLabel(fetchUserInfo, cred, log)`。
 */
export async function resolveAccountLabel(fetchUserInfo, credential, log = () => {}, o = {}) {
  try {
    const info = await fetchUserInfo(credential)
    return accountLabelOf(info, o)
  } catch (e) {
    log(`拿不到账号信息，卡片将显示供应商名：${e?.message ?? e}`)
    return ""
  }
}

/**
 * 登录成功时该交给宿主的那两个字段：`accountId` 是人看的名字，`uid` 是身份（规矩 ③ + ④）。
 *
 * ```js
 * const { urn, phone, name } = await readWhoSignedIn(cred) // 你的接口
 * return { type: "success", refresh, access, expires, ...resolveAccount({ phone, name, urn }) }
 * // → { accountId: "138****8000", uid: "iam::…:user:hw…" }
 * ```
 *
 * 名字全取不到就**不给 `accountId`**（宿主回退到供应商名），而不是拿 URN 顶上。
 */
export function resolveAccount({ phone, name, urn } = {}) {
  const phoneLabel = maskPhone(phone)
  const rawName = String(name ?? "").trim()
  const nameLabel = rawName && !looksLikeIdentifier(rawName) ? rawName : ""
  const accountId = phoneLabel || nameLabel
  const uid = String(urn ?? "").trim()
  return { ...(accountId ? { accountId } : {}), ...(uid ? { uid } : {}) }
}