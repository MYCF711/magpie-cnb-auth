// tests/refresh-lock.test.mjs —— 一次性 refresh_token 的并发闸
//
// 全部离线；不需要网络、不需要凭据。
// 跑法：node --test tests/refresh-lock.test.mjs

import test from "node:test"
import assert from "node:assert/strict"

import { createRefreshLock } from "../src/refresh-lock.mjs"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test("同 key 并发 10 次只调用一次，所有等待者拿到同一个结果", async () => {
  const lock = createRefreshLock({ replayMs: 60_000 })
  let calls = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })

  const fn = async () => {
    calls += 1
    await gate
    return { access: "new-token" }
  }

  const tasks = Array.from({ length: 10 }, () => lock.run("acct-1\nrefresh-a", fn))
  await Promise.resolve() // fn 在微任务里启动，先让它跑起来
  assert.equal(calls, 1, "in-flight 合并失败：fn 被调了不止一次")
  assert.ok(tasks.every((p) => p === tasks[0]), "同一个 key 的等待者必须拿到同一个 promise")

  release()
  const results = await Promise.all(tasks)
  assert.equal(calls, 1)
  for (const result of results) assert.deepEqual(result, { access: "new-token" })
  assert.equal(lock.pending, 0, "in-flight 表必须在结束后清空")
})

test("不同 key 各自独立执行", async () => {
  const lock = createRefreshLock()
  const seen = []
  const make = (name) => async () => {
    seen.push(name)
    return name
  }

  const [a, b, c] = await Promise.all([
    lock.run("acct-a", make("a")),
    lock.run("acct-b", make("b")),
    lock.run("acct-a", make("a-again")), // 与第一个同 key，应合并
  ])
  assert.deepEqual(seen.sort(), ["a", "b"])
  assert.equal(a, "a")
  assert.equal(b, "b")
  assert.equal(c, "a")
})

test("失败不缓存：所有等待者收到同一个错误，下一次会重新执行", async () => {
  const lock = createRefreshLock()
  let calls = 0
  const failure = new Error("invalid_grant")
  const fail = async () => {
    calls += 1
    await sleep(5)
    throw failure
  }

  const p1 = lock.run("acct\nrefresh", fail)
  const p2 = lock.run("acct\nrefresh", fail)
  assert.equal(p1, p2)

  await assert.rejects(p1, (err) => err === failure)
  await assert.rejects(p2, (err) => err === failure)
  assert.equal(calls, 1)
  assert.equal(lock.pending, 0, "失败的 in-flight 必须清理，否则会死锁")
  assert.equal(lock.size, 0, "错误不能进回放缓存")

  const retry = await lock.run("acct\nrefresh", async () => {
    calls += 1
    return "ok"
  })
  assert.equal(retry, "ok")
  assert.equal(calls, 2, "失败后必须允许重试")
})

test("成功结果按 replayMs 回放，过期后重新执行", async () => {
  const lock = createRefreshLock({ replayMs: 30 })
  let calls = 0
  const fn = async () => {
    calls += 1
    return calls
  }

  assert.equal(await lock.run("k", fn), 1)
  assert.equal(await lock.run("k", fn), 1, "replayMs 内必须命中回放缓存")
  assert.equal(calls, 1)
  assert.equal(lock.size, 1)

  await sleep(45)
  assert.equal(await lock.run("k", fn), 2, "回放过期后必须重新执行")
  assert.equal(calls, 2)
})

test("replayMs: 0 表示不回放，第二次立即重新执行", async () => {
  const lock = createRefreshLock({ replayMs: 0 })
  let calls = 0
  const fn = async () => ++calls
  assert.equal(await lock.run("k", fn), 1)
  assert.equal(await lock.run("k", fn), 2)
})

test("clear(key) 丢掉回放缓存，下一次重新执行", async () => {
  const lock = createRefreshLock({ replayMs: 60_000 })
  let calls = 0
  const fn = async () => ++calls

  assert.equal(await lock.run("k", fn), 1)
  assert.equal(await lock.run("k", fn), 1)
  lock.clear("k")
  assert.equal(lock.size, 0)
  assert.equal(await lock.run("k", fn), 2)
})

test("clear(key) 不清 in-flight：运行中的刷新不会被复制成第二次", async () => {
  const lock = createRefreshLock({ replayMs: 60_000 })
  let calls = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const fn = async () => {
    calls += 1
    await gate
    return "token"
  }

  const p1 = lock.run("k", fn)
  lock.clear("k")
  const p2 = lock.run("k", fn)
  await Promise.resolve()
  assert.equal(p1, p2)
  assert.equal(calls, 1)
  release()
  assert.equal(await p1, "token")
})

test("空 key / 非字符串 key 抛 TypeError", () => {
  const lock = createRefreshLock()
  for (const key of ["", "   ", null, undefined, 42, {}, []]) {
    assert.throws(() => lock.run(key, async () => 1), TypeError, `key=${String(key)} 应该抛 TypeError`)
    assert.throws(() => lock.clear(key), TypeError)
  }
})

test("sweep() 清理过期回放；run() 也会顺手清理，避免 Map 无界增长", async () => {
  const lock = createRefreshLock({ replayMs: 20 })
  let calls = 0
  const fn = async () => ++calls

  await lock.run("a", fn)
  await lock.run("b", fn)
  assert.equal(lock.size, 2)

  await sleep(30)
  assert.equal(lock.sweep(), 2, "sweep 应清掉两条过期回放")
  assert.equal(lock.size, 0)

  await lock.run("a", fn)
  await lock.run("b", fn)
  await sleep(30)
  await lock.run("c", fn) // run 前自动 sweep 掉 a/b
  assert.equal(lock.size, 1, "run 的自动 sweep 应只留下刚成功的 c")
})

test("fn 不是函数抛 TypeError；replayMs 非法抛 TypeError", () => {
  const lock = createRefreshLock()
  assert.throws(() => lock.run("k", null), TypeError)
  assert.throws(() => createRefreshLock({ replayMs: -1 }), TypeError)
  assert.throws(() => createRefreshLock({ replayMs: "60000" }), TypeError)
  assert.throws(() => createRefreshLock({ replayMs: Infinity }), TypeError)
})
