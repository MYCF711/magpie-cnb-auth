// src/openai-sse.mjs —— OpenAI 兼容 SSE 的解析 / 折叠（厂商无关原语）
//
// 为什么单独一个模块：上游只回 SSE、而客户端要非流式 JSON 时，自己 `split("\n")`
// 会在 CRLF 跨块、多行 data、注释、BOM、UTF-8 半字符上出错；不设上限还会被异常流
// 撑爆内存。这个模块只做**解析与折叠**，不默认改写任何请求，也不接管默认链路。
//
// 模式来源（都是 MIT）：
//   · @magpie-community/opencode-zen-free-auth/tool-response.mjs:523-639 —— framesFrom 的
//     TextDecoder(fatal, ignoreBOM) / CRLF 跨块 / 32 MiB event 上限
//   · @magpie-community/opencode-codearts-auth/index.mjs:1149-1368 —— parseSseEvents /
//     completionFromChunks / foldAnswer（usage 帧与 tool_calls 分片）
//
// 用法（只在需要时显式调用）：
//   const completion = await foldOpenAI(openAIEvents(res.body), { model })
//   return Response.json(completion)

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

export const SSE_MAX_BYTES = DEFAULT_MAX_BYTES

function normalizeMaxBytes(maxBytes) {
  if (maxBytes === undefined) return DEFAULT_MAX_BYTES
  if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new TypeError(`maxBytes 必须是正数，收到 ${maxBytes}`)
  }
  return maxBytes
}

function tooLarge(maxBytes) {
  const error = new Error(`上游 SSE 超过 ${maxBytes} 字节上限（默认 32 MiB）`)
  error.code = "SSE_TOO_LARGE"
  return error
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason
  return new DOMException("The operation was aborted.", "AbortError")
}

/** 逐行解析器：输入已解码的文本块，输出完整的 SSE 事件。 */
class SseParser {
  constructor(maxBytes) {
    this.maxBytes = maxBytes
    this.bytes = 0
    this.buffer = ""
    this.firstChunk = true
    this.skipLF = false
    this.eventName = ""
    this.dataLines = []
    this.rawLines = []
  }

  count(bytes) {
    this.bytes += bytes
    if (this.bytes > this.maxBytes) throw tooLarge(this.maxBytes)
  }

  push(text) {
    if (typeof text !== "string" || text === "") return []
    if (this.firstChunk) {
      this.firstChunk = false
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    }
    if (this.skipLF && text.length > 0) {
      if (text[0] === "\n") text = text.slice(1)
      this.skipLF = false
    }
    this.buffer += text

    const events = []
    let start = 0
    let i = 0
    while (i < this.buffer.length) {
      const ch = this.buffer[i]
      if (ch !== "\r" && ch !== "\n") {
        i++
        continue
      }
      const line = this.buffer.slice(start, i)
      let next = i + 1
      if (ch === "\r") {
        if (i + 1 < this.buffer.length && this.buffer[i + 1] === "\n") next = i + 2
        else if (i + 1 === this.buffer.length) this.skipLF = true // CRLF 的 LF 可能在下一块
      }
      this.line(line, events)
      start = next
      i = next
    }
    this.buffer = this.buffer.slice(start)
    return events
  }

  line(line, events) {
    if (line === "") {
      this.dispatch(events)
      return
    }
    if (line.startsWith(":")) return // 注释 / keepalive

    const colon = line.indexOf(":")
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    this.rawLines.push(line)

    if (field === "event") {
      this.eventName = value
      return
    }
    if (field === "data") {
      this.dataLines.push(value)
      return
    }
    // id / retry 等字段不影响 OpenAI 事件，只保留在 raw 里
  }

  dispatch(events) {
    if (this.dataLines.length > 0) {
      const data = this.dataLines.join("\n")
      const name = this.eventName
      events.push({
        name,
        event: name, // 别名：SSE 规范里这个字段叫 event
        data,
        text: data, // 别名：部分调用方沿用 zen 的 framesFrom 命名
        lines: [...this.rawLines],
        raw: `${this.rawLines.join("\n")}\n\n`,
      })
    }
    this.eventName = ""
    this.dataLines = []
    this.rawLines = []
  }

  end() {
    const events = []
    if (this.buffer.length > 0) {
      // 容忍服务端末尾没有空行：最后一行也按完整事件收尾
      this.line(this.buffer, events)
      this.buffer = ""
    }
    this.dispatch(events)
    return events
  }
}

/**
 * 解析一段完整的 SSE 文本（同步）。
 * 返回 `{ name, data, raw }[]`；`data` 是多行 data 用 `\n` 拼接后的原文，`[DONE]` 也会保留。
 */
export function parseSse(text, { maxBytes } = {}) {
  if (typeof text !== "string") throw new TypeError("parseSse 需要字符串")
  const limit = normalizeMaxBytes(maxBytes)
  const size = new TextEncoder().encode(text).byteLength
  if (size > limit) throw tooLarge(limit)

  const parser = new SseParser(limit)
  const events = parser.push(text)
  events.push(...parser.end())
  return events
}

/**
 * 从 `ReadableStream` / `Response.body` / 任何带 `getReader()` 的流里逐事件读。
 * 支持 CRLF 跨块、UTF-8 多字节跨块、BOM、注释、多行 data、超限与 abort。
 */
function chunkByteLength(value) {
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength
  if (value instanceof ArrayBuffer) return value.byteLength
  return value?.byteLength ?? 0
}

export async function* readSseEvents(body, { signal, maxBytes } = {}) {
  const limit = normalizeMaxBytes(maxBytes)
  const stream = body?.body ?? body
  if (!stream || typeof stream.getReader !== "function") {
    throw new TypeError("readSseEvents 需要 ReadableStream（或 Response）")
  }
  if (signal?.aborted) throw abortError(signal)

  const reader = stream.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  const parser = new SseParser(limit)
  let finished = false
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => {})
  }
  signal?.addEventListener("abort", onAbort, { once: true })

  try {
    for (;;) {
      if (signal?.aborted) throw abortError(signal)
      const { done, value } = await reader.read()
      if (done) break
      if (signal?.aborted) throw abortError(signal)
      if (value) {
        if (typeof value === "string") {
          // 显式支持 string chunk（有些调用方直接把解码后的文本交进来）
          parser.count(chunkByteLength(value))
          for (const event of parser.push(value)) yield event
        } else {
          parser.count(chunkByteLength(value))
          const text = decoder.decode(value, { stream: true })
          for (const event of parser.push(text)) yield event
        }
      }
    }
    // Abort 发生在 pending read 时，cancel() 可能让 read() 以 done 结束而不是抛错。
    // 这里必须再检查一次，否则调用方会把「已取消」当成正常结束、拿到半截 completion。
    if (signal?.aborted) throw abortError(signal)
    const tail = decoder.decode()
    parser.count(chunkByteLength(tail)) // 解码器尾部残留的字节也要计入上限
    for (const event of parser.push(tail)) yield event
    for (const event of parser.end()) yield event
    finished = true
  } finally {
    signal?.removeEventListener("abort", onAbort)
    if (!finished) {
      // 消费者提前 break / parser 抛错 / abort：必须取消上游 reader，否则流会挂在网络上
      try {
        await reader.cancel(signal?.reason ?? "SSE reader stopped")
      } catch {}
    }
    try {
      reader.releaseLock()
    } catch {}
  }
}

/**
 * 把 SSE 流解析成 OpenAI 事件对象。`[DONE]` 不产出。
 *
 * @param {ReadableStream | Response} body
 * @param {{ onInvalid?: "throw" | "skip", maxBytes?: number, signal?: AbortSignal }} [options]
 */
export function openAIEvents(body, { onInvalid = "throw", maxBytes, signal } = {}) {
  if (onInvalid !== "throw" && onInvalid !== "skip") {
    throw new TypeError(`onInvalid 只能是 "throw" 或 "skip"，收到 ${onInvalid}`)
  }
  return (async function* () {
    for await (const event of readSseEvents(body, { signal, maxBytes })) {
      const text = event.data.trim()
      if (text === "" || text === "[DONE]") continue

      let value
      try {
        value = JSON.parse(text)
      } catch (error) {
        if (onInvalid === "skip") continue
        const wrapped = new Error(`SSE 事件不是合法 JSON：${text.slice(0, 200)}`)
        wrapped.cause = error
        throw wrapped
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        if (onInvalid === "skip") continue
        throw new Error(`SSE 事件不是 JSON 对象：${text.slice(0, 200)}`)
      }
      yield value
    }
  })()
}

async function* asAsyncIterable(events) {
  if (events == null) return
  if (typeof events[Symbol.asyncIterator] === "function") {
    yield* events
    return
  }
  if (typeof events[Symbol.iterator] === "function") {
    for (const value of events) yield value
    return
  }
  throw new TypeError("foldOpenAI 需要事件数组或异步迭代器")
}

function choiceIndex(value) {
  if (value === undefined || value === null) return 0
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : 0
}

function appendString(target, key, value) {
  if (typeof value === "string") target[key] = (target[key] ?? "") + value
}

/**
 * 把 OpenAI Chat Completions 的流式事件折叠成一个完整的 `chat.completion` 对象。
 *
 * 合并 content / reasoning_content / tool_calls 分片；保留 usage（包括 `choices: []` 的
 * usage 帧）；finish_reason 缺省按「有工具调用 → tool_calls，否则 stop」。
 *
 * @param {Iterable<object> | AsyncIterable<object>} events
 * @param {{ id?: string, model?: string }} [options]
 */
export async function foldOpenAI(events, { id, model } = {}) {
  let firstId = ""
  let eventModel = ""
  let created = null
  let finish = null
  let usage = null
  const content = []
  const reasoning = []
  const calls = new Map()

  for await (const rawEvent of asAsyncIterable(events)) {
    let event = rawEvent
    // 也接受 parseSse/readSseEvents 的原始帧：自动把 data 解析成 JSON
    if (
      event &&
      typeof event === "object" &&
      typeof event.data === "string" &&
      !("choices" in event) &&
      !("usage" in event)
    ) {
      const text = event.data.trim()
      if (text === "" || text === "[DONE]") continue
      try {
        event = JSON.parse(text)
      } catch {
        continue
      }
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) continue
    if (!firstId && typeof event.id === "string" && event.id) firstId = event.id
    if (typeof event.model === "string" && event.model) eventModel = event.model
    if (event.created !== undefined && event.created !== null && Number.isFinite(Number(event.created))) {
      created = Number(event.created)
    }
    if (event.usage && typeof event.usage === "object") usage = event.usage

    const choice = Array.isArray(event.choices) ? event.choices[0] : undefined
    if (!choice || typeof choice !== "object") continue
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) finish = choice.finish_reason

    const delta =
      choice.delta && typeof choice.delta === "object"
        ? choice.delta
        : choice.message && typeof choice.message === "object"
          ? choice.message
          : {}

    if (typeof delta.content === "string") content.push(delta.content)
    if (typeof delta.reasoning_content === "string") reasoning.push(delta.reasoning_content)
    else if (typeof delta.reasoning === "string") reasoning.push(delta.reasoning)

    for (const fragment of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      if (!fragment || typeof fragment !== "object") continue
      const index = choiceIndex(fragment.index)
      const slot = calls.get(index) ?? {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      }
      if (typeof fragment.id === "string" && fragment.id) slot.id = fragment.id
      if (typeof fragment.type === "string" && fragment.type) slot.type = fragment.type
      if (fragment.function && typeof fragment.function === "object") {
        appendString(slot.function, "name", fragment.function.name)
        appendString(slot.function, "arguments", fragment.function.arguments)
      }
      calls.set(index, slot)
    }

    // 旧的 function_call 单调用形态（部分兼容上游）
    if (delta.function_call && typeof delta.function_call === "object") {
      const slot = calls.get(0) ?? { id: "", type: "function", function: { name: "", arguments: "" } }
      appendString(slot.function, "name", delta.function_call.name)
      appendString(slot.function, "arguments", delta.function_call.arguments)
      calls.set(0, slot)
    }
  }

  const sortedCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)
  const message = {
    role: "assistant",
    content: content.length > 0 ? content.join("") : sortedCalls.length > 0 ? null : "",
  }
  if (reasoning.length > 0) message.reasoning_content = reasoning.join("")
  if (sortedCalls.length > 0) message.tool_calls = sortedCalls

  const completion = {
    id: id || firstId || `chatcmpl-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: created ?? Math.floor(Date.now() / 1000),
    model: model ?? eventModel ?? "",
    choices: [
      {
        index: 0,
        message,
        finish_reason: finish ?? (sortedCalls.length > 0 ? "tool_calls" : "stop"),
      },
    ],
  }
  if (usage) completion.usage = usage
  return completion
}
