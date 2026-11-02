// 一次性邮箱：建址、收码、抽数字
import test from "node:test"
import assert from "node:assert/strict"

import { createTempMailbox, waitTempCode, _internal } from "../src/tempmail-client.mjs"

test("从邮件正文抽验证码：优先「验证码」附近，退到独立 6 位", () => {
  assert.equal(_internal.codeOf("您的验证码是 482913，5 分钟内有效"), "482913")
  assert.equal(_internal.codeOf("Your verification code: 771234"), "771234")
  assert.equal(_internal.codeOf("订单 123456789 已创建，验证码 654321"), "654321")
  assert.equal(_internal.codeOf("no digits here"), "")
})

test("建邮箱 → 轮询收件 → 拿到验证码", async () => {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null })
    if (String(url).endsWith("/v3/email/new")) {
      return new Response(JSON.stringify({ email: "user@example.com", token: "t" }), { status: 200 })
    }
    return new Response(JSON.stringify([{ body_text: "Your code is 123456" }]), { status: 200 })
  }
  try {
    const mb = await createTempMailbox({ base: "https://mail.test/api" })
    assert.equal(mb.address, "user@example.com")
    const code = await waitTempCode(mb.address, {
      base: "https://mail.test/api",
      timeoutMs: 3000,
      intervalMs: 10,
    })
    assert.equal(code, "123456")
    assert.equal(calls[0].body.domain, "yzcalo.com")
  } finally {
    globalThis.fetch = real
  }
})