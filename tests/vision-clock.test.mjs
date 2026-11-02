// 识图判角度：钟点换算 / 分歧判断 / 两个判官 / 400 兼容
import test from "node:test"
import assert from "node:assert/strict"

import {
  CLOCK_MAX_SPREAD,
  clockToDeg,
  clockSpread,
  decideDegFromImage,
  resetGatewayCache,
} from "../src/vision-clock.mjs"

test("钟点 → 顺时针角度：12 点=0、6 点=180、3 点=270", () => {
  assert.equal(clockToDeg(12), 0)
  assert.equal(clockToDeg(6), 180)
  assert.equal(clockToDeg(3), 270)
  assert.equal(clockToDeg(0), 0)
  assert.equal(clockToDeg(10.5), 45)
})

test("分歧按最短环距：1.7 vs 7.5 差 5.8 钟点，超过阈值", () => {
  assert.ok(Math.abs(clockSpread(1.7, 7.5) - 5.8) < 1e-9)
  assert.ok(clockSpread(1.7, 7.5) > CLOCK_MAX_SPREAD)
  assert.ok(Math.abs(clockSpread(11.8, 0.2) - 0.4) < 1e-9)
})

test("两个判官一致 → 取平均并换算角度", async () => {
  resetGatewayCache()
  const real = globalThis.fetch
  const bodies = []
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/v1/models")) return new Response("{}", { status: 200 })
    bodies.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify({ choices: [{ message: { content: "6" } }] }), { status: 200 })
  }
  try {
    const r = await decideDegFromImage("data:image/png;base64,AAAA", { model: "test/vision" })
    assert.equal(r.ok, true)
    assert.equal(r.clock, 6)
    assert.equal(r.deg, 180)
    assert.equal(bodies.length, 2, "应该并行问两次")
    for (const b of bodies) {
      assert.equal(b.model, "test/vision")
      assert.equal(b.max_tokens, 6000)
      assert.equal(b.reasoning_effort, "low")
    }
  } finally {
    globalThis.fetch = real
    resetGatewayCache()
  }
})

test("两个判官差 5.8 钟点 → 判「不可信」，不拿平均去撞", async () => {
  resetGatewayCache()
  const real = globalThis.fetch
  let i = 0
  const answers = ["1.7", "7.5"]
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/v1/models")) return new Response("{}", { status: 200 })
    const content = answers[i++ % answers.length]
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
  }
  try {
    const r = await decideDegFromImage("data:image/png;base64,AAAA", { model: "test/vision" })
    assert.equal(r.ok, false)
    assert.equal(r.reason, "disagree")
    assert.match(r.detail, /1\.7 vs 7\.5/)
  } finally {
    globalThis.fetch = real
    resetGatewayCache()
  }
})

test("reasoning_effort 被 400 → 去掉重发一次", async () => {
  resetGatewayCache()
  const real = globalThis.fetch
  let chat = 0
  const seen = []
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/v1/models")) return new Response("{}", { status: 200 })
    const body = JSON.parse(String(init.body))
    seen.push(body)
    chat++
    if (chat === 1) return new Response("bad request", { status: 400 })
    return new Response(JSON.stringify({ choices: [{ message: { content: "9" } }] }), { status: 200 })
  }
  try {
    const r = await decideDegFromImage("data:image/png;base64,AAAA", { model: "test/vision" })
    assert.equal(r.ok, true)
    assert.equal(r.clock, 9)
    // 第一次带字段被 400，去掉后重发；两个判官各走一次这条兜底
    assert.ok(seen.some((b) => Object.hasOwn(b, "reasoning_effort")))
    assert.ok(seen.some((b) => !Object.hasOwn(b, "reasoning_effort")))
  } finally {
    globalThis.fetch = real
    resetGatewayCache()
  }
})