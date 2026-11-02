// tests/oauth-pkce.test.mjs —— PKCE + 本机 loopback 回调
//
// 全部走真实 127.0.0.1 HTTP，不触外网；每个用例结束都关闭服务器，不留句柄。
// 跑法：node --test tests/oauth-pkce.test.mjs

import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"

import { generatePkce, randomState, startLoopback } from "../src/oauth-pkce.mjs"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function callbackUrl(flow, params = {}) {
  const url = new URL(flow.redirectUri)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value)
  }
  return url.toString()
}

async function withFlow(options, run) {
  const flow = await startLoopback(options)
  try {
    await run(flow)
  } finally {
    flow.close()
  }
}

test("generatePkce：verifier 43-128 个 base64url 字符，challenge 是它的 S256", () => {
  const { verifier, challenge, method } = generatePkce()
  assert.equal(method, "S256")
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/)
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/)
  const expected = createHash("sha256").update(verifier).digest("base64url")
  assert.equal(challenge, expected)
  assert.notEqual(generatePkce().verifier, verifier, "两次生成的 verifier 不能相同")
})

test("randomState：非空、base64url、每次不同", () => {
  const a = randomState()
  const b = randomState()
  assert.match(a, /^[A-Za-z0-9_-]{16,128}$/)
  assert.notEqual(a, b)
})

test("startLoopback：正确回调 → wait() 解析 { code, state, query }", async () => {
  const state = randomState()
  await withFlow({ state }, async (flow) => {
    assert.match(flow.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/)
    assert.ok(Number.isInteger(flow.port) && flow.port > 0)

    const wait = flow.wait()
    const res = await fetch(callbackUrl(flow, { code: "abc123", state, extra: "x" }))
    assert.equal(res.status, 200)
    assert.match(await res.text(), /登录完成/)

    const result = await wait
    assert.equal(result.code, "abc123")
    assert.equal(result.state, state)
    assert.equal(result.query.extra, "x")
  })
})

test("错误 path 返回 404，但不结束等待；随后正确回调仍能 resolve", async () => {
  const state = randomState()
  await withFlow({ state }, async (flow) => {
    const wait = flow.wait()
    const wrong = await fetch(`http://127.0.0.1:${flow.port}/not-the-callback`)
    assert.equal(wrong.status, 404)

    let settled = false
    wait.then(
      () => (settled = true),
      () => (settled = true),
    )
    await sleep(20)
    assert.equal(settled, false, "错误 path 不应结束流程")

    const res = await fetch(callbackUrl(flow, { code: "ok", state }))
    assert.equal(res.status, 200)
    assert.equal((await wait).code, "ok")
  })
})

test("错误 state 返回 400，但不结束等待；正确 state 的回调随后 resolve", async () => {
  const state = randomState()
  await withFlow({ state }, async (flow) => {
    const wait = flow.wait()
    const wrong = await fetch(callbackUrl(flow, { code: "evil", state: "not-the-state" }))
    assert.equal(wrong.status, 400)

    let settled = false
    wait.then(
      () => (settled = true),
      () => (settled = true),
    )
    await sleep(20)
    assert.equal(settled, false, "错误 state 不应结束流程")

    const res = await fetch(callbackUrl(flow, { code: "good", state }))
    assert.equal(res.status, 200)
    assert.equal((await wait).state, state)
  })
})

test("缺 code → wait() reject", async () => {
  const state = randomState()
  await withFlow({ state }, async (flow) => {
    const wait = flow.wait()
    // 先挂上断言：服务器可能在 fetch 的响应体读完之前就 reject
    const rejected = assert.rejects(wait, /缺少有效 code/)
    const res = await fetch(callbackUrl(flow, { state }))
    assert.equal(res.status, 400)
    await rejected
  })
})

test("OAuth error 参数 → wait() reject，并带上厂商错误", async () => {
  const state = randomState()
  await withFlow({ state }, async (flow) => {
    const wait = flow.wait()
    const rejected = assert.rejects(wait, /access_denied/)
    const res = await fetch(callbackUrl(flow, { error: "access_denied", state }))
    assert.equal(res.status, 400)
    await rejected
  })
})

test("超时 → wait() reject", async () => {
  const flow = await startLoopback({ state: randomState(), timeoutMs: 50 })
  try {
    await assert.rejects(flow.wait(), /超时/)
  } finally {
    flow.close()
  }
})

test("AbortSignal → wait() reject（AbortError）", async () => {
  const controller = new AbortController()
  const flow = await startLoopback({ state: randomState(), signal: controller.signal, timeoutMs: 5_000 })
  try {
    const wait = flow.wait()
    controller.abort()
    await assert.rejects(wait, (error) => error?.name === "AbortError")
    assert.equal(flow.port > 0, true)
  } finally {
    flow.close()
  }
})

test("close() → 等待者 reject，且重复调用安全", async () => {
  const flow = await startLoopback({ state: randomState() })
  const wait = flow.wait()
  flow.close()
  flow.close()
  await assert.rejects(wait, /已关闭/)

  // close 之后再 wait 也应该立刻 reject
  await assert.rejects(flow.wait(), /已关闭/)
})

test("非 GET → 405；自定义 successHtml / failureHtml 生效", async () => {
  const state = randomState()
  const flow = await startLoopback({
    state,
    successHtml: "<h1>CUSTOM-OK</h1>",
    failureHtml: "<h1>CUSTOM-FAIL</h1>",
  })
  try {
    const post = await fetch(flow.redirectUri, { method: "POST" })
    assert.equal(post.status, 405)

    const bad = await fetch(callbackUrl(flow, { state: "wrong" }))
    assert.equal(bad.status, 400)
    assert.match(await bad.text(), /CUSTOM-FAIL/)

    const wait = flow.wait()
    const ok = await fetch(callbackUrl(flow, { code: "c", state }))
    assert.equal(ok.status, 200)
    assert.match(await ok.text(), /CUSTOM-OK/)
    assert.equal((await wait).code, "c")
  } finally {
    flow.close()
  }
})

test("参数校验：缺 state / 非 / 开头 path / 非正 timeout 都抛 TypeError", async () => {
  await assert.rejects(() => startLoopback({}), TypeError)
  await assert.rejects(() => startLoopback({ state: "  " }), TypeError)
  await assert.rejects(() => startLoopback({ state: "s", path: "oauth" }), TypeError)
  await assert.rejects(() => startLoopback({ state: "s", timeoutMs: 0 }), TypeError)
})
