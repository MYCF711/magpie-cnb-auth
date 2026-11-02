// tests/request-rewrite.test.mjs —— JSON 请求体改写管道
//
// 全部离线，不构造真实上游；只锁「不该改的不要改、改过的要能看出改了」。

import test from "node:test"
import assert from "node:assert/strict"

import {
  rewriteJsonBody,
  rewriteRequest,
  ensureStreamUsage,
  clampMaxTokens,
  stripModelPrefix,
  stripHopHeaders,
} from "../src/request-rewrite.mjs"

test("没有命中关键字时返回原字符串引用；坏 JSON 也原样返回", () => {
  const raw = '{"foo":1}'
  assert.equal(rewriteJsonBody(raw, [ensureStreamUsage]), raw)
  assert.equal(rewriteJsonBody(raw, [ensureStreamUsage]), raw, "不能重新 stringify")

  const bad = '{"stream":true,'
  assert.equal(rewriteJsonBody(bad, [ensureStreamUsage]), bad)
})

test("stream:true 补 stream_options.include_usage；stream:false 不动", () => {
  const streamed = rewriteJsonBody('{"stream":true,"messages":[]}', [ensureStreamUsage])
  assert.deepEqual(JSON.parse(streamed), {
    stream: true,
    messages: [],
    stream_options: { include_usage: true },
  })

  const notStream = '{"stream":false,"messages":[]}'
  assert.equal(rewriteJsonBody(notStream, [ensureStreamUsage]), notStream)

  const already = '{"stream":true,"stream_options":{"include_usage":true}}'
  assert.equal(rewriteJsonBody(already, [ensureStreamUsage]), already)
})

test("max_tokens / max_completion_tokens 低于下限才抬，非数字不改", () => {
  const clamped = rewriteJsonBody('{"max_tokens":128,"messages":[]}', [clampMaxTokens(512)])
  assert.equal(JSON.parse(clamped).max_tokens, 512)

  const clamped2 = rewriteJsonBody('{"max_completion_tokens":32}', [clampMaxTokens(512)])
  assert.equal(JSON.parse(clamped2).max_completion_tokens, 512)

  const high = '{"max_tokens":1024}'
  assert.equal(rewriteJsonBody(high, [clampMaxTokens(512)]), high)

  const nonNumber = '{"max_tokens":"128"}'
  assert.equal(rewriteJsonBody(nonNumber, [clampMaxTokens(512)]), nonNumber)
})

test("stripModelPrefix 只剥指定前缀，不影响其他模型名", () => {
  const strip = stripModelPrefix("acme")
  const out = rewriteJsonBody('{"model":"acme/glm-5","messages":[]}', [strip])
  assert.equal(JSON.parse(out).model, "glm-5")

  const other = '{"model":"other/glm-5"}'
  assert.equal(rewriteJsonBody(other, [strip]), other)
})

test("工具 schema 的 additionalProperties:false 绝不改", () => {
  const raw = JSON.stringify({
    stream: true,
    max_tokens: 64,
    tools: [
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { q: { type: "string" } },
          },
        },
      },
    ],
  })
  const out = rewriteJsonBody(raw, [ensureStreamUsage, clampMaxTokens(512)])
  const body = JSON.parse(out)
  assert.equal(body.max_tokens, 512)
  assert.equal(body.tools[0].function.parameters.additionalProperties, false)
  assert.deepEqual(body.tools[0].function.parameters.properties, { q: { type: "string" } })
})

test("stripHopHeaders 去掉 content-length / content-encoding，保留其他头与 body", async () => {
  const res = new Response("hello", {
    status: 201,
    headers: {
      "content-type": "text/plain",
      "content-length": "5",
      "content-encoding": "gzip",
      "x-trace": "abc",
    },
  })
  const out = stripHopHeaders(res)
  assert.equal(out.status, 201)
  assert.equal(out.headers.get("content-length"), null)
  assert.equal(out.headers.get("content-encoding"), null)
  assert.equal(out.headers.get("x-trace"), "abc")
  assert.equal(await out.text(), "hello")
})

test("rewriteRequest 是内置组合：identity 快路径 + stream/max_tokens", () => {
  const untouched = '{"messages":[]}'
  assert.equal(rewriteRequest(untouched), untouched)
  const out = rewriteRequest('{"stream":true,"max_tokens":8}')
  assert.deepEqual(JSON.parse(out), {
    stream: true,
    max_tokens: 512,
    stream_options: { include_usage: true },
  })
})

test("fastRe:null 时允许自定义字段的 transform", () => {
  const raw = '{"custom":1}'
  const out = rewriteJsonBody(raw, [(body) => {
    body.custom = 2
    return true
  }], { fastRe: null })
  assert.deepEqual(JSON.parse(out), { custom: 2 })
})

test("参数校验：非法 transforms / min / 前缀都抛", () => {
  assert.throws(() => rewriteJsonBody("{}", null), TypeError)
  assert.throws(() => rewriteJsonBody('{"stream":true}', [null]), TypeError)
  assert.throws(() => clampMaxTokens(0), TypeError)
  assert.throws(() => stripModelPrefix(""), TypeError)
})