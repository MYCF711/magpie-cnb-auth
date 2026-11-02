// 旋转验证码：角度编码、WAF cookie 回传、取图/判角/提交重试
import test from "node:test"
import assert from "node:assert/strict"

import {
  createCookieJar,
  createRotationCaptcha,
  encodeAngle,
  solveRotationCaptcha,
} from "../src/rotation-captcha.mjs"
import { CLOCK_MAX_SPREAD, clockSpread, clockToDeg } from "../src/vision-clock.mjs"

const manual = (deg, n) => {
  const d = BigInt(((deg % 360) + 360) % 360)
  return String((52249517n * (d + BigInt(n)) + 5976906165n) & 0xffffffffn) + String(n)
}

test("角度编码与前端公式一致，且 n 拼在最后", () => {
  for (const [deg, n] of [[0, 10000], [120, 12345], [359, 99999], [360, 54321], [-30, 11111]]) {
    assert.equal(encodeAngle(deg, n), manual(deg, n))
  }
})

test("钟点换算与分歧阈值", () => {
  assert.equal(clockToDeg(6), 180)
  assert.equal(clockToDeg(10.5), 45)
  assert.ok(clockSpread(1.7, 7.5) > CLOCK_MAX_SPREAD)
})

test("generate 的 set-cookie 会带回 verify（WAF 客户端校验）", async () => {
  const jar = createCookieJar()
  const seen = []
  const fake = async (url, init = {}) => {
    seen.push({ url: String(url), cookie: init.headers.cookie || "" })
    if (String(url).endsWith("/captcha/generate")) {
      return new Response(JSON.stringify({ code: 1000, data: { token: "tok", image: "data:image/webp;base64,AA" } }), {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": "acw_tc=abc123;path=/;HttpOnly" },
      })
    }
    return new Response(JSON.stringify({ code: 1000, data: { verified: true, business_token: "biz" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  const c = createRotationCaptcha({ base: "https://k.example.com", origin: "https://www.example.com", fetchImpl: fake, jar })
  const cap = await c.generate({ account_type: "email", email: "a@b.com" })
  assert.equal(cap.token, "tok")
  const v = await c.verify({ token: cap.token, deg: 90, account_type: "email", email: "a@b.com" })
  assert.equal(v.ok, true)
  assert.equal(v.businessToken, "biz")
  assert.equal(seen[1].cookie, "acw_tc=abc123")
})

test("判角不可信 → 换图重试；第二次通过", async () => {
  let n = 0
  const log = []
  const r = await solveRotationCaptcha({
    generate: async () => ({ registered: false, token: `t${++n}`, image: `img${n}` }),
    decide: async () => (n === 1 ? { ok: false, reason: "disagree", detail: "1.7 vs 7.5" } : { ok: true, deg: 180 }),
    verify: async (deg) => ({ ok: true, businessToken: `biz-${deg}` }),
    maxRounds: 4,
    gapMs: 0,
    log,
  })
  assert.equal(r.ok, true)
  assert.equal(r.rounds, 2)
  assert.equal(r.businessToken, "biz-180")
  assert.match(log[0], /判角度不可信/)
})

test("服务端说已注册 → 直接拿 business_token，不判角", async () => {
  let decided = false
  const r = await solveRotationCaptcha({
    generate: async () => ({ registered: true, businessToken: "biz-free" }),
    decide: async () => {
      decided = true
      return { ok: true, deg: 0 }
    },
    verify: async () => ({ ok: false }),
    gapMs: 0,
  })
  assert.equal(r.ok, true)
  assert.equal(r.businessToken, "biz-free")
  assert.equal(decided, false)
})