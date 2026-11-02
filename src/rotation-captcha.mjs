// 「旋转图片使角度为正」验证码的通用客户端
//
// 适用于这类协议：取图 → 识图判角度 → 提交角度 → 拿到 business_token → 发验证码 / 换登录态。
//
// 三块可复用的东西：
//   ① **角度编码**：`angle = ((52249517 * (deg + n) + 5976906165) & 0xFFFFFFFF)` + 5 位 n。
//      这是从网页前端反出来的（实测：抓 4 组真实提交，正向穷举 0…359 每组唯一命中，
//      且命中值与拖动像素严格成 1.6°/px）。**别改系数。**
//   ② **WAF cookie 罐**：`/captcha/generate` 会回 `set-cookie: acw_tc=…`，`/captcha/verify`
//      不带回去就回 `2000 客户端信息不匹配`。Node 的 fetch 默认没有 cookie jar ——
//      浏览器天生带，所以纯 HTTP 客户端会踩，而前端从来不会。
//   ③ **判角度重试**：识图模型会给出「不可信」答案（两个判官分歧），换图重试比硬提交更省。
//      `solveRotationCaptcha` 把「取图 → 判 → 提交 → 失败换图」的循环收在一处。
//
// ⚠ 本模块不猜端点、不猜字段名：`generate` / `verify` / `send` 的 body 由调用方给，
//   因为不同厂商的标识字段（`email` / `mobile` + `state_code`）和登录端点都不一样。

export const CAPTCHA_CODE = { OK: 1000, BAD: 2000 }

/**
 * 角度 → 服务端要的字符串。
 * @param {number} deg 0…359，图片**顺时针**旋转的角度
 * @param {number} n 5 位随机数（10000…99999）
 */
export function encodeAngle(deg, n) {
  const d = ((BigInt(deg) % 360n) + 360n) % 360n
  const nn = BigInt(n)
  const v = (52249517n * (d + nn) + 5976906165n) & 0xffffffffn
  return String(v) + String(n)
}

/** 服务端给的 n 是 5 位（10000…99999）；我们自己造一个同样形状的 */
export function randomN() {
  return Math.floor(Math.random() * 90000) + 10000
}

/**
 * 按 origin 分开的 cookie 罐。
 *
 * ⚠ 不做「全局一份」：不同厂商/不同站点的 WAF cookie 名字可能撞，混在一起会把 A 站
 *   的会话带到 B 站。按 origin 分桶最省事。
 */
export function createCookieJar() {
  const jars = new Map() // origin -> Map(name, value)
  const header = (origin) => {
    const jar = jars.get(origin)
    if (!jar || !jar.size) return ""
    return [...jar].map(([k, v]) => `${k}=${v}`).join("; ")
  }
  const remember = (origin, res) => {
    let list = []
    try {
      list = res.headers.getSetCookie?.() ?? []
    } catch {
      /* 老运行时没有 getSetCookie */
    }
    if (!list.length) {
      const raw = res.headers.get("set-cookie")
      if (raw) list = [raw]
    }
    if (!list.length) return
    let jar = jars.get(origin)
    if (!jar) {
      jar = new Map()
      jars.set(origin, jar)
    }
    for (const line of list) {
      const first = String(line).split(";")[0]
      const at = first.indexOf("=")
      if (at <= 0) continue
      jar.set(first.slice(0, at).trim(), first.slice(at + 1).trim())
    }
  }
  const clear = () => jars.clear()
  return { header, remember, clear }
}

/**
 * 造一个绑定到某个站点的 captcha 客户端。
 *
 * @param {object} opts
 * @param {string} opts.base 例如 `https://keewood-service.example.com`
 * @param {string} opts.origin 页面 origin，例如 `https://www.example.com`
 * @param {typeof fetch} [opts.fetchImpl] 测试注入
 * @param {number} [opts.timeoutMs] 默认 90s（跨国链路 20s 太短：实测会出现
 *   「客户端已超时、服务端随后才把短信发出去」）
 * @param {{header:Function,remember:Function,clear:Function}} [opts.jar]
 */
export function createRotationCaptcha({
  base,
  origin,
  fetchImpl = fetch,
  timeoutMs = 90_000,
  jar = createCookieJar(),
} = {}) {
  const post = async (path, body, extraHeaders = {}) => {
    const url = `${base}${path}`
    const o = new URL(url).origin
    const cookie = jar.header(o)
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        ...extraHeaders,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    jar.remember(o, res)
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON 交给调用方看 text */
    }
    return { status: res.status, text, json }
  }

  return {
    jar,
    post,
    /**
     * 取图。返回 `{registered:true, businessToken}` 或 `{registered:false, token, image}`。
     * 已注册的号服务端直接给 business_token（跳过旋转图）—— 先取图再判断，
     * 不要一上来就因为「没配识图模型」把这条免费通道堵死。
     */
    async generate(ident = {}) {
      const { json } = await post("/captcha/generate", ident)
      const d = json?.data ?? {}
      if (d.business_token) return { registered: true, businessToken: d.business_token }
      if (!d.token || !d.image) {
        throw new Error(`取验证码失败：${json?.message ?? "没有 token/image"}`)
      }
      return {
        registered: false,
        token: String(d.token),
        image: String(d.image),
        expireAt: d.expire_time ? Number(d.expire_time) * 1000 : null,
      }
    },
    /** 提交角度。`ident` 是账号标识字段（email / mobile + state_code …） */
    async verify({ token, deg, ...ident }) {
      const n = randomN()
      const { json } = await post("/captcha/verify", {
        token,
        angle: encodeAngle(deg, n),
        ...ident,
      })
      const d = json?.data ?? {}
      if (d.verified && d.business_token) return { ok: true, businessToken: d.business_token }
      return { ok: false, message: json?.message ?? "验证失败" }
    },
    /** 发验证码 / 换登录态等后续请求（带 `X-Captcha-Token` 的场景由调用方传） */
    send(path, body, extraHeaders = {}) {
      return post(path, body, extraHeaders)
    },
  }
}

/**
 * 「取图 → 识图判角 → 提交 → 失败换图」的循环。识图模型返回不可信时直接换图，
 * 不拿一个平均出来的角度去撞（服务端容差只有 ±10°）。
 *
 * @param {object} opts
 * @param {() => Promise<object>} opts.generate 返回 `{registered, businessToken, token, image}`
 * @param {(image:string) => Promise<{ok:true,deg:number}|{ok:false,reason:string,detail?:string}>} opts.decide
 * @param {(deg:number) => Promise<{ok:boolean, businessToken?:string, message?:string}>} opts.verify
 * @param {number} [opts.maxRounds=4]
 * @param {number} [opts.gapMs=2600] 两次提交之间的间隔（服务端有「提交过于频繁」风控）
 * @returns {Promise<{ok:true, businessToken:string, rounds:number, log:string[]}>}
 */
export async function solveRotationCaptcha({
  generate,
  decide,
  verify,
  maxRounds = 4,
  gapMs = 2600,
  log = [],
}) {
  let lastReason = ""
  for (let round = 1; round <= maxRounds; round++) {
    const cap = await generate()
    if (cap?.registered) {
      log.push(`第 ${round} 轮：服务端说这个号已注册，直接给 business_token（跳过旋转图）`)
      return { ok: true, businessToken: cap.businessToken, rounds: round - 1, log }
    }
    const decided = await decide(cap.image)
    if (!decided?.ok) {
      lastReason = decided?.detail ?? decided?.reason ?? "判角度失败"
      log.push(`第 ${round} 轮：判角度不可信（${lastReason}），换图`)
      if (round < maxRounds) await new Promise((r) => setTimeout(r, gapMs))
      continue
    }
    const res = await verify(decided.deg)
    if (res?.ok) {
      log.push(`第 ${round} 轮：deg=${decided.deg} 通过`)
      return { ok: true, businessToken: res.businessToken, rounds: round, log }
    }
    lastReason = res?.message ?? "验证失败"
    log.push(`第 ${round} 轮：deg=${decided.deg} 没通过（${lastReason}）`)
    if (round < maxRounds) await new Promise((r) => setTimeout(r, gapMs))
  }
  throw Object.assign(
    new Error(`旋转验证连试 ${maxRounds} 张图都没过（最后一次：${lastReason}）`),
    { captchaLog: log.slice() },
  )
}