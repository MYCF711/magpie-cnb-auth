// 一次性邮箱客户端：给「邮箱验证码自动登录」那条路用
//
// 公开站点内部 API，无需 key。第一步建一个随机地址，第二步轮询收件箱抽 4~8 位验证码。
//
// ⚠ 域名会被部分上游拉黑：实测 magicrew（2026-10-29）拒绝 `maxxspace.com`（mail.tm）/
//   `guerrillamailblock.com` / `mailinator.com` 的地址，而 `qq.com` / `163.com` /
//   `gmail.com` / `yzcalo.com` 直接过 —— 这是**域名黑名单**，不是识图问题。
//   换厂商时先用一条真实验证码请求确认域名没被拦，再决定是否用它做默认。
//
// ⚠ 这类地址是一次性的：登录成功后应当把邮箱从结果里拿掉，只保留它注册出来的账号，
//   不要把临时邮箱当成用户的联系方式写进账号名。

const BASE = "https://api.internal.temp-mail.io/api"
const DOMAIN = "yzcalo.com"

function nameOf() {
  return "mk" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/**
 * 建一个一次性邮箱。
 * @returns {Promise<{address:string, token:string}>}
 */
export async function createTempMailbox({ base = BASE, domain = DOMAIN, name = nameOf() } = {}) {
  const res = await fetch(`${base}/v3/email/new`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, domain }),
    signal: AbortSignal.timeout(20_000),
  })
  const raw = await res.text()
  let j = null
  try {
    j = JSON.parse(raw)
  } catch {}
  if (!j?.email) throw new Error(`temp-mail.io 建邮箱失败 HTTP ${res.status}：${raw.slice(0, 300)}`)
  return { address: j.email, token: j.token || "" }
}

/** 从一封信里抽验证码：先认「验证码/verification code」附近的数字，再退到独立的 6 位数字 */
function codeOf(text) {
  const s = String(text || "")
  const near = s.match(/(?:验证码|校验码|验证代码|verification\s*code|code)[^\d]{0,30}(\d{4,8})/i)
  if (near) return near[1]
  const six = s.match(/(?<!\d)(\d{6})(?!\d)/)
  return six ? six[1] : ""
}

/**
 * 轮询收件箱，直到抽到验证码或超时。
 * @returns {Promise<string>} 4~8 位数字
 */
export async function waitTempCode(
  address,
  { base = BASE, timeoutMs = 150_000, intervalMs = 3_000 } = {},
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/v3/email/${encodeURIComponent(address)}/messages`, {
      signal: AbortSignal.timeout(20_000),
    })
    const list = await res.json().catch(() => null)
    if (Array.isArray(list)) {
      for (const m of list) {
        const code = codeOf(`${m.body_text || ""}\n${m.body_html || ""}`)
        if (code) return code
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`临时邮箱 ${Math.round(timeoutMs / 1000)} 秒内没收到验证码`)
}

export const _internal = { codeOf }