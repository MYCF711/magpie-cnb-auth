// tests/openai-sse.test.mjs —— OpenAI 兼容 SSE 的解析 / 折叠
//
// 全部离线：用 ReadableStream 造帧，不触网络。
// 跑法：node --test tests/openai-sse.test.mjs

import test from "node:test"
import assert from "node:assert/strict"

import { parseSse, readSseEvents, openAIEvents, foldOpenAI } from "../src/openai-sse.mjs"

const encoder = new TextEncoder()

function streamOf(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk)
      }
      controller.close()
    },
  })
}

async function collect(iterable) {
  const out = []
  for await (const value of iterable) out.push(value)
  return out
}

test("parseSse：BOM / CRLF / 多行 data / 注释 / event 名 / [DONE]", () => {
  const text =
    "\uFEFF: keepalive\r\n\r\n" +
    'data: {"a":\r\ndata: 1}\r\n\r\n' +
    'event: ping\r\ndata: {"type":"x"}\r\n\r\n' +
    "data: [DONE]\r\n\r\n"
  const events = parseSse(text)
  assert.equal(events.length, 3)
  assert.equal(events[0].data, '{"a":\n1}')
  assert.equal(JSON.parse(events[0].data).a, 1)
  assert.equal(events[1].name, "ping")
  assert.equal(events[1].data, '{"type":"x"}')
  assert.equal(events[2].data, "[DONE]")
})

test("parseSse：末尾没有空行也能收尾（容忍服务端省略最后空行）", () => {
  const events = parseSse('data: {"ok":true}')
  assert.equal(events.length, 1)
  assert.deepEqual(JSON.parse(events[0].data), { ok: true })
})

test("parseSse：超过 maxBytes 抛错", () => {
  assert.throws(() => parseSse("data: 1234567890\n\n", { maxBytes: 5 }), /上限/)
  assert.throws(() => parseSse("data: x\n\n", { maxBytes: 0 }), TypeError)
  assert.throws(() => parseSse(123), TypeError)
})

test("readSseEvents：UTF-8 多字节字符与 CRLF 跨 chunk 都能正确解析", async () => {
  const text = 'data: {"text":"你好"}\r\n\r\n'
  const bytes = encoder.encode(text)
  const niIndex = text.indexOf("你")
  const niByte = encoder.encode(text.slice(0, niIndex)).byteLength
  const crIndex = text.indexOf("\r")
  const crByte = encoder.encode(text.slice(0, crIndex)).byteLength
  const chunks = [bytes.slice(0, niByte + 1), bytes.slice(niByte + 1, crByte + 1), bytes.slice(crByte + 1)]

  const events = await collect(readSseEvents(streamOf(chunks)))
  assert.equal(events.length, 1)
  assert.deepEqual(JSON.parse(events[0].data), { text: "你好" })
})

test("readSseEvents：接受 Response.body，超过 maxBytes 抛错", async () => {
  const response = new Response('data: {"long":"' + "x".repeat(100) + '"}\r\n\r\n')
  const start = Date.now()
  await assert.rejects(async () => {
    for await (const _ of readSseEvents(response, { maxBytes: 10 })) {
      // 不会到这里
    }
  }, /上限/)
  assert.ok(Date.now() - start < 1000)
})

test("readSseEvents：AbortSignal 在开始前/开始后都抛 AbortError", async () => {
  const before = new AbortController()
  before.abort()
  await assert.rejects(
    async () => {
      for await (const _ of readSseEvents(streamOf(["data: {}\n\n"]), { signal: before.signal })) {
        // noop
      }
    },
    (error) => error?.name === "AbortError",
  )

  const after = new AbortController()
  let first = true
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: {}\n\n"))
    },
    pull(controller) {
      if (first) {
        first = false
        after.abort()
        controller.error(new DOMException("aborted", "AbortError"))
      }
    },
  })
  await assert.rejects(
    async () => {
      for await (const _ of readSseEvents(stream, { signal: after.signal })) {
        // noop
      }
    },
    (error) => error?.name === "AbortError",
  )
})

test("readSseEvents：pending read 期间 abort，cancel() 正常返回也必须抛 AbortError", async () => {
  const controller = new AbortController()
  // 没有 enqueue、没有 close：reader.read() 一直 pending，cancel() 会让它以 done 结束。
  const stream = new ReadableStream({ start() {} })
  const iterator = readSseEvents(stream, { signal: controller.signal })
  const pending = iterator.next()
  controller.abort()
  await assert.rejects(pending, (error) => error?.name === "AbortError")
})

test("readSseEvents：显式支持 string chunk（不交给 TextDecoder）", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue('data: {"from":"string"}\n\n')
      controller.close()
    },
  })
  const events = await collect(readSseEvents(stream))
  assert.equal(events.length, 1)
  assert.deepEqual(JSON.parse(events[0].data), { from: "string" })
})

test("readSseEvents：消费者提前 break 会 cancel 上游 reader", async () => {
  let cancelled = false
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"a":1}\n\n'))
      // 故意不 close：模拟一个还挂着的上游流
    },
    cancel() {
      cancelled = true
    },
  })
  const iterator = readSseEvents(stream)
  const first = await iterator.next()
  assert.equal(first.done, false)
  await iterator.return()
  assert.equal(cancelled, true, "提前 break 必须取消上游 reader，否则连接会一直挂着")
})

test("openAIEvents：坏 JSON 的 throw / skip 两种模式", async () => {
  const text = 'data: not-json\n\ndata: {"choices":[]}\n\ndata: [DONE]\n\n'

  await assert.rejects(
    async () => {
      for await (const _ of openAIEvents(streamOf([text]))) {
        // noop
      }
    },
    /不是合法 JSON/,
  )

  const events = await collect(openAIEvents(streamOf([text]), { onInvalid: "skip" }))
  assert.equal(events.length, 1)
  assert.deepEqual(events[0], { choices: [] })

  assert.throws(() => openAIEvents(streamOf([text]), { onInvalid: "wat" }), TypeError)
})

test("openAIEvents：[DONE] 与空帧不产出", async () => {
  const events = await collect(openAIEvents(streamOf(['data: [DONE]\n\n', "\n\n", 'data: {"id":"x"}\n\n'])))
  assert.deepEqual(events, [{ id: "x" }])
})

test("foldOpenAI：content / reasoning_content / tool_calls 分片合并，usage 保留", async () => {
  const events = [
    { id: "chatcmpl-1", model: "m-1", created: 1_700_000_000, choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] },
    { choices: [{ index: 0, delta: { content: "lo", reasoning_content: "think-" } }] },
    { choices: [{ index: 0, delta: { reasoning_content: "done" } }] },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_", arguments: '{"a"' } }],
          },
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { name: "weather", arguments: ":1}" } }] },
        },
      ],
    },
    { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]

  const completion = await foldOpenAI(events, { model: "request-model" })
  assert.equal(completion.id, "chatcmpl-1")
  assert.equal(completion.object, "chat.completion")
  assert.equal(completion.created, 1_700_000_000)
  assert.equal(completion.model, "request-model")
  assert.equal(completion.choices[0].message.content, "Hello")
  assert.equal(completion.choices[0].message.reasoning_content, "think-done")
  assert.equal(completion.choices[0].message.tool_calls.length, 1)
  assert.equal(completion.choices[0].message.tool_calls[0].function.name, "get_weather")
  assert.equal(completion.choices[0].message.tool_calls[0].function.arguments, '{"a":1}')
  assert.equal(completion.choices[0].finish_reason, "tool_calls")
  assert.deepEqual(completion.usage, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 })
})

test("foldOpenAI：只有工具调用时 content 为 null，finish_reason 缺省 tool_calls", async () => {
  const completion = await foldOpenAI([
    { id: "x", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c", function: { name: "f", arguments: "{}" } }] } }] },
  ])
  assert.equal(completion.choices[0].message.content, null)
  assert.equal(completion.choices[0].finish_reason, "tool_calls")
  assert.equal(completion.model, "")
  assert.ok(completion.created > 0)
})

test("foldOpenAI：纯文本且没有 finish_reason → 缺省 stop", async () => {
  const completion = await foldOpenAI([
    { id: "x", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] },
  ])
  assert.equal(completion.choices[0].message.content, "hi")
  assert.equal(completion.choices[0].finish_reason, "stop")
  assert.equal(completion.usage, undefined)
})

test("foldOpenAI：接受 openAIEvents 异步生成器；usage 帧 choices 为空也能保留", async () => {
  const text =
    'data: {"id":"chatcmpl-2","model":"m","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":6,"total_tokens":11}}\n\n' +
    "data: [DONE]\n\n"
  const completion = await foldOpenAI(openAIEvents(streamOf([text])))
  assert.equal(completion.choices[0].message.content, "ok")
  assert.deepEqual(completion.usage, { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 })
})

test("foldOpenAI：非 iterable 抛 TypeError", async () => {
  await assert.rejects(() => foldOpenAI(42), TypeError)
})
