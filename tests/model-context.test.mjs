// tests/model-context.test.mjs —— 模型上下文窗口查库
//
// 全部离线：用注入的 readFile 或临时目录，不读真实 ~/.cache（默认实例那条用随机 id）。
// 跑法：node --test tests/model-context.test.mjs

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

import { createModelContext, contextOf, _resetDefaultContext } from "../src/model-context.mjs"

const FIXTURE = {
  providers: {
    deepseek: {
      models: [
        { id: "deepseek-ai/deepseek-v4.1-flash", limit: { context: 1_048_576 } },
        { id: "deepseek-ai/deepseek-r1", limit: { context: 131_072 } },
      ],
    },
    other: {
      models: [
        { id: "other/deepseek-v4.1-flash", limit: { context: 2_097_152 } },
        { id: "other/deepseek-r1", context_length: 65_536 },
        { id: "plain-model", context_window: 32_768 },
      ],
    },
  },
}

function fixtureReader(text = JSON.stringify(FIXTURE)) {
  const calls = []
  const readFile = (path, encoding) => {
    calls.push({ path, encoding })
    return text
  }
  readFile.calls = calls
  return readFile
}

test("精确 id 命中（大小写不敏感）", () => {
  const ctx = createModelContext({ readFile: fixtureReader() })
  assert.equal(ctx.contextOf("deepseek-ai/deepseek-v4.1-flash"), 1_048_576)
  assert.equal(ctx.contextOf("DEEPSEEK-AI/DEEPSEEK-V4.1-FLASH"), 1_048_576)
})

test("尾段命中：查询裸模型名也能找到", () => {
  const ctx = createModelContext({ readFile: fixtureReader() })
  assert.equal(ctx.contextOf("deepseek-r1"), 131_072)
})

test("不同厂商前缀同一个模型 → 取最大值", () => {
  const ctx = createModelContext({ readFile: fixtureReader() })
  assert.equal(ctx.contextOf("deepseek-v4.1-flash"), 2_097_152)
  // 换个厂商前缀也按尾段取最大
  assert.equal(ctx.contextOf("unknown-vendor/deepseek-v4.1-flash"), 2_097_152)
})

test("兼容 context_length / context_window 字段；纯对象条目也能递归建索引", () => {
  const ctx = createModelContext({ readFile: fixtureReader() })
  assert.equal(ctx.contextOf("plain-model"), 32_768)
  assert.equal(ctx.size, 5)
})

test("查不到：合法正数 fallback 返回它，否则 undefined", () => {
  const ctx = createModelContext({ readFile: fixtureReader() })
  assert.equal(ctx.contextOf("no-such-model", { fallback: 123_456 }), 123_456)
  assert.equal(ctx.contextOf("no-such-model"), undefined)
  assert.equal(ctx.contextOf("no-such-model", { fallback: 0 }), undefined)
  assert.equal(ctx.contextOf("no-such-model", { fallback: -5 }), undefined)
  assert.equal(ctx.contextOf("no-such-model", { fallback: "abc" }), undefined)
  assert.equal(ctx.contextOf("no-such-model", { fallback: Infinity }), undefined)
  assert.equal(ctx.contextOf("no-such-model", { fallback: "4096" }), 4096, "数字字符串是合法正数")
})

test("坏 JSON / 文件缺失都不抛，按查不到处理", () => {
  const badJson = createModelContext({ readFile: () => "{ this is not json" })
  assert.equal(badJson.contextOf("x", { fallback: 777 }), 777)
  assert.equal(badJson.size, 0)

  const missing = createModelContext({
    readFile: () => {
      throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })
    },
  })
  assert.equal(missing.contextOf("x", { fallback: 888 }), 888)
})

test("TTL 缓存：cacheMs 内只读一次，过期后重读，clear() 立即重读", () => {
  const readFile = fixtureReader()
  let nowMs = 1_000
  const ctx = createModelContext({ readFile, cacheMs: 100, now: () => nowMs })

  ctx.contextOf("deepseek-r1")
  ctx.contextOf("deepseek-r1")
  assert.equal(readFile.calls.length, 1)

  nowMs += 101
  ctx.contextOf("deepseek-r1")
  assert.equal(readFile.calls.length, 2)

  ctx.clear()
  ctx.contextOf("deepseek-r1")
  assert.equal(readFile.calls.length, 3)
})

test("readFile 返回 Buffer 也能解析", () => {
  const ctx = createModelContext({ readFile: () => Buffer.from(JSON.stringify(FIXTURE), "utf8") })
  assert.equal(ctx.contextOf("deepseek-r1"), 131_072)
})

test("参数校验：非法 readFile / now / cacheMs 抛 TypeError", () => {
  assert.throws(() => createModelContext({ readFile: 1 }), TypeError)
  assert.throws(() => createModelContext({ now: "now" }), TypeError)
  assert.throws(() => createModelContext({ cacheMs: -1 }), TypeError)
  assert.throws(() => createModelContext({ cacheMs: Infinity }), TypeError)
})

test("真实临时文件：libraryPath 生效", async () => {
  const dir = await mkdtemp(join(tmpdir(), "magpie-model-context-"))
  try {
    const file = join(dir, "models.json")
    await writeFile(file, JSON.stringify(FIXTURE), "utf8")
    const ctx = createModelContext({ libraryPath: file })
    assert.equal(ctx.contextOf("deepseek-v4.1-flash"), 2_097_152)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("默认实例导出 contextOf：查不到返回给定 fallback，不抛", () => {
  _resetDefaultContext()
  const fake = `not-a-real-model-${randomUUID()}`
  assert.equal(contextOf(fake, { fallback: 4_096 }), 4_096)
  assert.equal(contextOf(fake), undefined)
})
