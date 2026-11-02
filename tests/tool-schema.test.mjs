// tests/tool-schema.test.mjs —— 工具名截断 + 工具 schema 兼容改写
//
// 全部离线、不构造真实上游：只锁三件事 ——
//   ① 默认关闭必须是 identity（同一个引用，不是「值相等」）
//   ② 显式开启后只改该改的：名字超长才截、additionalProperties 非布尔才换、
//      items:{} 才删、只有 items 子树里的 union 才摊平
//   ③ 任何情况下都不修改传入对象（深冻结的输入也能安全改写）
//
// ⚠ 这里只测模块契约，不代表真实上游已经接受改写后的请求 —— 挂载验证见回报的「没做什么」。

import test from "node:test"
import assert from "node:assert/strict"

import {
  DEFAULT_MAX_TOOL_NAME_LENGTH,
  adaptToolList,
  createToolSchemaAdapter,
  loosenToolSchema,
  rewriteToolSchema,
  truncateToolName,
  truncateToolNames,
} from "../src/tool-schema.mjs"

/** 「任意值」的六类型数组，与 src/tool-schema.mjs 里的 ANY_SCHEMA_TYPE 对齐 */
const ANY_TYPE = ["object", "string", "number", "boolean", "array", "null"]

function tool(name, parameters = { type: "object" }) {
  return { type: "function", function: { name, parameters } }
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** 扫一棵 schema 树：空对象路径 + union/const/not 关键字路径（复查 items 子树用） */
function scanSchema(node, path = "$") {
  const empty = []
  const union = []
  if (Array.isArray(node)) {
    node.forEach((child, index) => {
      const found = scanSchema(child, `${path}[${index}]`)
      empty.push(...found.empty)
      union.push(...found.union)
    })
    return { empty, union }
  }
  if (!node || typeof node !== "object") return { empty, union }
  if (Object.keys(node).length === 0) empty.push(path)
  for (const [key, value] of Object.entries(node)) {
    if (["anyOf", "oneOf", "allOf", "not", "const", "if", "then", "else"].includes(key)) {
      union.push(`${path}.${key}`)
    }
    const found = scanSchema(value, `${path}.${key}`)
    empty.push(...found.empty)
    union.push(...found.union)
  }
  return { empty, union }
}

// ── ⑤ 默认关闭 = identity ──────────────────────────────────────────────

test("默认关闭：对象与 JSON 字符串都原样返回同一个引用（identity）", () => {
  const body = {
    tools: [tool("mcp__server__a_very_long_tool_name_that_exceeds_any_reasonable_limit", {
      type: "object",
      additionalProperties: {},
    })],
  }
  const adapter = createToolSchemaAdapter()
  assert.equal(adapter.enabled, false)
  assert.equal(adapter.error, null)
  assert.equal(adapter.adapt(body), body)
  assert.equal(rewriteToolSchema(body), body)

  const raw = JSON.stringify(body)
  assert.equal(adapter.adapt(raw), raw)
  assert.equal(rewriteToolSchema(raw), raw)
  assert.equal(createToolSchemaAdapter({ enabled: false }).adapt(body), body)
})

test("显式 enabled:true 才改写；开启但没有可改的也返回原引用", () => {
  const plain = { tools: [tool("lookup", { type: "object", properties: { q: { type: "string" } } })] }
  assert.equal(createToolSchemaAdapter({ enabled: true }).adapt(plain), plain)

  const body = { tools: [tool("lookup", { type: "object", additionalProperties: { type: "string" } })] }
  const out = createToolSchemaAdapter({ enabled: true }).adapt(body)
  assert.notEqual(out, body)
  assert.equal(out.tools[0].function.parameters.additionalProperties, true)
})

// ── ① 工具名超长截断且保持唯一 ─────────────────────────────────────────

test("工具名超长截断且保持唯一；短名一动不动", () => {
  const max = 24
  const shared = "mcp__server__a_very_long_shared_prefix_"
  const longA = `${shared}alpha`
  const longB = `${shared}beta`

  const plan = truncateToolNames(["short", longA, longB], { maxToolNameLength: max })
  assert.equal(plan.ok, true)
  assert.equal(plan.changed, true)
  assert.equal(plan.names[0], "short")
  for (const name of plan.names) assert.ok(name.length <= max, `${name} 超长`)
  assert.notEqual(plan.names[1], plan.names[2])
  assert.equal(new Set(plan.names).size, plan.names.length)
  assert.equal(plan.renamed[longA], plan.names[1])
  assert.equal(plan.renamed[longB], plan.names[2])
})

test("截断结果撞上已有短名时改用去重序号，结果仍两两不同", () => {
  const max = 24
  const long = `mcp__server__collision_${"z".repeat(60)}`
  const natural = truncateToolName(long, max)
  assert.ok(typeof natural === "string" && natural.length <= max)

  const plan = truncateToolNames(["taken", natural, long], { maxToolNameLength: max })
  assert.equal(plan.ok, true)
  assert.equal(plan.names[1], natural, "本来就短的名字不许被改")
  assert.notEqual(plan.names[2], natural, "撞上已有名字必须换一个")
  assert.ok(plan.names[2].length <= max)
  assert.equal(new Set(plan.names).size, plan.names.length)
})

test("truncateToolName：同输入同输出、后缀稳定、短名与非字符串原样", () => {
  const long = "x".repeat(100)
  const first = truncateToolName(long, DEFAULT_MAX_TOOL_NAME_LENGTH)
  const second = truncateToolName(long, DEFAULT_MAX_TOOL_NAME_LENGTH)
  assert.equal(first, second)
  assert.ok(first.length <= DEFAULT_MAX_TOOL_NAME_LENGTH)
  assert.match(first, /~[a-z0-9]{7}$/)
  assert.equal(truncateToolName("short"), "short")
  assert.equal(truncateToolName(42), 42)
})

test("adaptToolList 同时支持 chat completions 与 Responses API 两种工具形状", () => {
  const longName = `mcp__server__${"q".repeat(80)}`
  const chat = adaptToolList([tool(longName, { type: "object", additionalProperties: {} })], {
    maxToolNameLength: 32,
  })
  assert.equal(chat.ok, true)
  assert.ok(chat.tools[0].function.name.length <= 32)
  assert.equal(chat.tools[0].function.parameters.additionalProperties, true)

  const responsesTools = [
    { type: "function", name: longName, parameters: { type: "object", additionalProperties: {} } },
  ]
  const responses = adaptToolList(responsesTools, { maxToolNameLength: 32 })
  assert.equal(responses.ok, true)
  assert.ok(responses.tools[0].name.length <= 32)
  assert.equal(responses.tools[0].parameters.additionalProperties, true)
  // 原数组不动
  assert.deepEqual(responsesTools[0].parameters.additionalProperties, {})
})

// ── ② additionalProperties 非布尔 → true ──────────────────────────────

test("additionalProperties：非布尔一律换 true，布尔值（含 false）绝不改", () => {
  const schema = {
    type: "object",
    additionalProperties: {},
    properties: {
      a: { type: "object", additionalProperties: { type: "string" } },
      b: { type: "object", additionalProperties: false },
      c: { type: "object", additionalProperties: true },
    },
  }
  const result = loosenToolSchema(schema)
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.equal(result.schema.additionalProperties, true)
  assert.equal(result.schema.properties.a.additionalProperties, true)
  assert.equal(result.schema.properties.b.additionalProperties, false, "false 语义相反，绝不动")
  assert.equal(result.schema.properties.c.additionalProperties, true)
})

test("恰好叫 additionalProperties 的属性名不被误改；它自己的 schema 里有关键字照改", () => {
  const untouched = { type: "object", properties: { additionalProperties: {} } }
  const result = loosenToolSchema(untouched)
  assert.equal(result.changed, false)
  assert.deepEqual(result.schema, untouched)

  const nested = { type: "object", properties: { additionalProperties: { type: "object", additionalProperties: {} } } }
  const changed = loosenToolSchema(nested)
  assert.equal(changed.ok, true)
  assert.equal(changed.changed, true)
  assert.deepEqual(changed.schema.properties.additionalProperties, {
    type: "object",
    additionalProperties: true,
  })
})

// ── ③ items:{} 删除 ───────────────────────────────────────────────────

test("items:{} / true 删除；{description} / false / {type} 保留", () => {
  const schema = {
    type: "object",
    properties: {
      a: { type: "array", items: {} },
      b: { type: "array", items: true },
      c: { type: "array", items: { description: "x" } },
      d: { type: "array", items: false },
      e: { type: "array", items: { type: "string" } },
    },
  }
  const result = loosenToolSchema(schema)
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.equal(result.schema.properties.a.items, undefined)
  assert.equal(result.schema.properties.b.items, undefined)
  assert.deepEqual(result.schema.properties.c.items, { description: "x" })
  assert.equal(result.schema.properties.d.items, false)
  assert.deepEqual(result.schema.properties.e.items, { type: "string" })
})

test("items 嵌套在 properties / anyOf 里也会删", () => {
  const schema = {
    type: "object",
    properties: {
      a: { type: "array", items: { type: "array", items: {} } },
      b: { anyOf: [{ type: "array", items: {} }, { type: "string" }] },
    },
  }
  const result = loosenToolSchema(schema)
  assert.equal(result.changed, true)
  assert.equal(result.schema.properties.a.items.items, undefined)
  assert.equal(result.schema.properties.b.anyOf[0].items, undefined)
})

// ── ④ items 子树 anyOf 摊平后不留空 {} ─────────────────────────────────

test("items 子树：anyOf 摊平、const/not/if 删除，改完不留空 {}", () => {
  const schema = {
    type: "object",
    properties: {
      functions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            // 可选值标准写法：取非 null 分支，不能压成「只能 null」
            subject: { anyOf: [{ type: "null" }, { type: "string" }] },
            kind: { const: "text" },
            not_: { not: { type: "string" } },
            cond: { if: { type: "string" }, then: { minLength: 1 } },
            raw: {},
            nested: { anyOf: [{ oneOf: [{ type: "object" }, { type: "null" }] }, { type: "null" }] },
          },
        },
      },
    },
  }

  const result = loosenToolSchema(schema)
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)

  const items = result.schema.properties.functions.items
  assert.deepEqual(items.properties.subject, { type: "string" })
  assert.deepEqual(items.properties.kind, { type: ANY_TYPE })
  assert.deepEqual(items.properties.not_, { type: ANY_TYPE })
  assert.deepEqual(items.properties.cond, { type: ANY_TYPE })
  assert.deepEqual(items.properties.raw, { type: ANY_TYPE })
  assert.deepEqual(items.properties.nested, { type: "object" })

  // 复查：items 子树里一个 union 关键字、一个空 schema 都不许剩
  const found = scanSchema(items)
  assert.deepEqual(found.union, [])
  assert.deepEqual(found.empty, [])
})

test("顶层 parameters 的 anyOf 不动 —— 上游收它，动了只会白丢约束", () => {
  const schema = {
    type: "object",
    properties: { x: { anyOf: [{ type: "string" }, { type: "null" }] } },
  }
  const result = loosenToolSchema(schema)
  assert.equal(result.ok, true)
  assert.equal(result.changed, false)
  assert.deepEqual(result.schema, schema)
})

test("tuple 形式的 items（数组）落成「任意值」；兄弟节点不受影响", () => {
  const schema = {
    type: "object",
    properties: {
      functions: { type: "array", items: [{ type: "string" }, { type: "number" }] },
      other: { type: "array", items: { type: "string" } },
    },
  }
  const result = loosenToolSchema(schema)
  assert.equal(result.changed, true)
  assert.deepEqual(result.schema.properties.functions.items, { type: ANY_TYPE })
  assert.deepEqual(result.schema.properties.other.items, { type: "string" })
})

// ── ⑥ 不修改传入对象（immutability） ──────────────────────────────────

test("不修改传入对象：深冻结的 schema / body 也能安全改写，原值逐字不变", () => {
  const schema = deepFreeze({
    type: "object",
    additionalProperties: {},
    properties: { f: { type: "array", items: { anyOf: [{ type: "null" }, { type: "string" }] } } },
  })
  const schemaSnapshot = structuredClone(schema)
  const loose = loosenToolSchema(schema)
  assert.equal(loose.ok, true)
  assert.notEqual(loose.schema, schema)
  assert.deepEqual(schema, schemaSnapshot)

  const longName = `mcp__server__${"y".repeat(90)}`
  const body = deepFreeze({
    model: "demo",
    tools: [tool(longName, {
      type: "object",
      additionalProperties: {},
      properties: { f: { type: "array", items: { anyOf: [{ type: "null" }, { type: "string" }] } } },
    })],
    tool_choice: { type: "function", function: { name: longName } },
  })
  const bodySnapshot = structuredClone(body)
  const out = createToolSchemaAdapter({ enabled: true, maxToolNameLength: 32 }).adapt(body)
  assert.notEqual(out, body)
  assert.deepEqual(body, bodySnapshot)
  assert.equal(out.tool_choice.function.name, out.tools[0].function.name, "tool_choice 必须跟着改名")
})

// ── 其余契约：字符串 body / 错误用返回值 / 引用快路径 ──────────────────

test("字符串 body：有改动才重新序列化；坏 JSON / 无 tools / 非对象原样返回", () => {
  const raw = JSON.stringify({ tools: [tool("lookup", { type: "object", additionalProperties: {} })] })
  const out = rewriteToolSchema(raw, { enabled: true })
  assert.equal(typeof out, "string")
  assert.equal(JSON.parse(out).tools[0].function.parameters.additionalProperties, true)

  const bad = '{"tools":['
  assert.equal(rewriteToolSchema(bad, { enabled: true }), bad)
  const noTools = '{"messages":[]}'
  assert.equal(rewriteToolSchema(noTools, { enabled: true }), noTools)
  assert.equal(rewriteToolSchema("null", { enabled: true }), "null")
})

test("非法参数与坏输入用返回值表达，全程不抛", () => {
  const badAdapter = createToolSchemaAdapter({ enabled: "yes" })
  assert.equal(badAdapter.enabled, false)
  assert.match(badAdapter.error, /布尔/)
  const body = { tools: [] }
  assert.equal(badAdapter.adapt(body), body)

  const badMax = truncateToolNames([], { maxToolNameLength: 3 })
  assert.equal(badMax.ok, false)
  assert.match(badMax.error, /maxToolNameLength/)

  assert.equal(loosenToolSchema(null).ok, false)
  assert.equal(loosenToolSchema([]).ok, false)
  assert.equal(adaptToolList("x").ok, false)
  assert.equal(truncateToolNames("x").ok, false)
  assert.equal(truncateToolNames(["ok", 42]).ok, false)
})

test("真实形态：70 个工具 + 一个超长 MCP 名 + REA 式 functions.items 一次改写通过", () => {
  const longName = `mcp__rea__build_call_path_${"a".repeat(70)}`
  const tools = []
  for (let i = 0; i < 69; i++) {
    tools.push(tool(`tool_${i}`, { type: "object", properties: { q: { type: "string" } } }))
  }
  tools.push(tool(longName, {
    type: "object",
    properties: {
      functions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            subject: { anyOf: [{ type: "null" }, { type: "string" }] },
            normalized_result: {},
            kind: { const: "text" },
          },
          additionalProperties: false,
        },
      },
    },
    required: ["functions"],
  }))

  const body = { model: "demo", messages: [{ role: "user", content: "hi" }], tools }
  const out = createToolSchemaAdapter({ enabled: true, maxToolNameLength: 64 }).adapt(body)
  assert.notEqual(out, body)
  assert.equal(out.tools.length, 70)
  assert.ok(out.tools[69].function.name.length <= 64)
  assert.equal(new Set(out.tools.map((t) => t.function.name)).size, 70)

  const parameters = out.tools[69].function.parameters
  const items = parameters.properties.functions.items
  assert.equal(items.additionalProperties, false, "布尔 false 保留")
  const found = scanSchema(items)
  assert.deepEqual(found.union, [])
  assert.deepEqual(found.empty, [])
  assert.deepEqual(items.properties.subject, { type: "string" })
  assert.deepEqual(items.properties.normalized_result, { type: ANY_TYPE })

  // 前面 69 个工具一字不动
  assert.deepEqual(out.tools[0], tools[0])
  assert.deepEqual(out.tools[68], tools[68])
  // 原 body 不动
  assert.deepEqual(body, { model: "demo", messages: [{ role: "user", content: "hi" }], tools })
})
