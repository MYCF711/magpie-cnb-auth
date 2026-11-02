// tests/usage-cache.test.mjs —— 额度读取缓存 + 耗尽闸
//
// 全部离线：compute 是注入的假函数，时间也是注入的。

import test from "node:test"
import assert from "node:assert/strict"

import { createUsageCache, exhausted, publicUsage } from "../src/usage-cache.mjs"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test("成功结果在 ttlMs 内命中缓存，不同 key 不串", async () => {
  let at = 0
  const cache = createUsageCache({ ttlMs: 5_000, failTtlMs: 1_000, now: () => at })
  let a = 0
  let b = 0
  const computeA = async () => {
    a += 1
    return { windows: [{ name: "a" }] }
  }
  const computeB = async () => {
    b += 1
    return { windows: [{ name: "b" }] }
  }

  assert.deepEqual(await cache.read("session-a", computeA), { windows: [{ name: "a" }] })
  assert.deepEqual(await cache.read("session-a", computeA), { windows: [{ name: "a" }] })
  assert.equal(a, 1)
  assert.equal(cache.size, 1)

  assert.deepEqual(await cache.read("session-b", computeB), { windows: [{ name: "b" }] })
  assert.equal(a, 1)
  assert.equal(b, 1)
  assert.equal(cache.size, 2)

  at += 5_001
  await cache.read("session-a", computeA)
  assert.equal(a, 2, "过期后必须重新计算")
})

test("失败结果只缓存 failTtlMs，过期后允许重试", async () => {
  let at = 0
  const cache = createUsageCache({ failTtlMs: 1_000, now: () => at })
  let calls = 0
  const failure = new Error("upstream timeout")
  const compute = async () => {
    calls += 1
    throw failure
  }

  await assert.rejects(cache.read("s", compute), (e) => e === failure)
  await assert.rejects(cache.read("s", compute), (e) => e === failure)
  assert.equal(calls, 1, "failTtlMs 内应命中失败缓存")

  at += 1_001
  await assert.rejects(cache.read("s", compute), (e) => e === failure)
  assert.equal(calls, 2, "失败缓存过期后必须重试")
})

test("同 key 并发只执行一次，等待者拿到同一个结果", async () => {
  let calls = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const cache = createUsageCache()
  const compute = async () => {
    calls += 1
    await gate
    return { windows: [{ used: 1 }] }
  }

  const tasks = Array.from({ length: 8 }, () => cache.read("same", compute))
  await Promise.resolve()
  assert.equal(calls, 1)
  assert.equal(cache.pending, 1)
  release()
  const values = await Promise.all(tasks)
  assert.equal(calls, 1)
  for (const value of values) assert.deepEqual(value, { windows: [{ used: 1 }] })
  assert.equal(cache.pending, 0)
})

test("clear() 清全部；clear(key) 只清指定 key", async () => {
  const cache = createUsageCache()
  let a = 0
  let b = 0
  await cache.read("a", async () => ++a)
  await cache.read("b", async () => ++b)
  cache.clear("a")
  assert.equal(cache.size, 1)
  assert.equal(await cache.read("a", async () => ++a), 2)
  assert.equal(await cache.read("b", async () => ++b), 1)
  cache.clear()
  assert.equal(cache.size, 0)
})

test("ttlMs: 0 表示不缓存", async () => {
  const cache = createUsageCache({ ttlMs: 0, failTtlMs: 0 })
  let calls = 0
  const fn = async () => ++calls
  assert.equal(await cache.read("k", fn), 1)
  assert.equal(await cache.read("k", fn), 2)
})

test("publicUsage 只去掉顶层下划线字段", () => {
  const value = { windows: [{ _internal: 1, used: 2 }], _quota: { known: true }, plan: "Pro" }
  assert.deepEqual(publicUsage(value), { windows: [{ _internal: 1, used: 2 }], plan: "Pro" })
  assert.equal(publicUsage(null), null)
  assert.deepEqual(publicUsage([1]), [1])
})

test("exhausted 只在有窗口、有余额读数且余额 ≤ lead 时为 true", () => {
  assert.equal(exhausted(null), false)
  assert.equal(exhausted({ error: "x", windows: [{}], balance: 0 }), false)
  assert.equal(exhausted({ windows: [], balance: 0 }), false)
  assert.equal(exhausted({ windows: [{}] }), false, "没有余额字段时放行")
  assert.equal(exhausted({ windows: [{}], balance: "12" }), false)
  assert.equal(exhausted({ windows: [{}], balance: "0" }), true)
  assert.equal(exhausted({ windows: [{}], balance: "0.5" }, { leadPoints: 1 }), true)
  assert.equal(exhausted({ windows: [{}], balance: 2 }, { leadPoints: 1 }), false)
})

test("参数校验：空 key / 非法 TTL / 非法 leadPoints 都抛", () => {
  assert.throws(() => createUsageCache({ ttlMs: -1 }), TypeError)
  assert.throws(() => createUsageCache({ failTtlMs: Infinity }), TypeError)
  const cache = createUsageCache()
  assert.throws(() => cache.read("", async () => 1), TypeError)
  assert.throws(() => cache.read("k", null), TypeError)
  assert.throws(() => exhausted({ windows: [{}], balance: 0 }, { leadPoints: -1 }), TypeError)
})

test("并发失败时所有等待者收到同一个错误，且 pending 清空", async () => {
  let calls = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const failure = new Error("bad gateway")
  const cache = createUsageCache({ failTtlMs: 0 })
  const compute = async () => {
    calls += 1
    await gate
    throw failure
  }
  const p1 = cache.read("x", compute)
  const p2 = cache.read("x", compute)
  release()
  await assert.rejects(p1, (e) => e === failure)
  await assert.rejects(p2, (e) => e === failure)
  assert.equal(calls, 1)
  assert.equal(cache.pending, 0)
})