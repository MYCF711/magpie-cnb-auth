// src/tool-schema.mjs —— 工具名截断 + 工具 schema 兼容改写（纯函数，默认关闭）
//
// 为什么单独一个模块：有些 OpenAI 兼容上游对「工具定义」有两类硬限制 ——
//
//   · 工具名超过长度上限（常见 64 字符）直接 400。MCP 工具名天生很长
//     （`mcp__<server>__<tool>`），一个超长就把整轮请求打死。
//   · 工具 schema 里某些**合法的** JSON Schema 形态上游解析不了：
//     `additionalProperties` 只要不是布尔、`items: {}`、以及 `items` 子树里的
//     `anyOf` / `oneOf` / `allOf` / `not` / `const` / `if` / 空 schema。
//
// 这些改写都会**改变模型看到的工具定义**：放宽约束可能让模型多传未声明的字段。
// 所以本模块**默认关闭**，只作显式 adapter —— 调用方自己决定要不要用：
//
//   import { createToolSchemaAdapter } from "./src/tool-schema.mjs"
//   const adapt = createToolSchemaAdapter({ enabled: true })   // ← 只有这里显式打开才生效
//   body = adapt(body)
//
// ⚠ 与 `src/request-rewrite.mjs` 的分工：那个模块的铁律是「工具 schema 与
//   `additionalProperties:false` 绝不改」，它不调用本模块；本模块也不改它一行。
//   同一个请求里两套改写不要同时挂 —— 只有确认上游需要兼容时才显式开启这一套。
//
// 三条纪律（对应测试里的三道锁）：
//   ① 默认关闭：`enabled !== true` 时**原样返回入参**（同一个引用，不复制、不 parse）
//   ② 纯函数：永远不修改传入的对象；要改就深拷贝后再改，返回新对象
//   ③ 不抛：非法参数 / 坏 JSON 都用返回值表达（`{ ok: false, error }`），
//      由调用方决定是忽略还是记录 —— 在每请求都跑的热路径上抛异常会打死整轮请求

export const DEFAULT_MAX_TOOL_NAME_LENGTH = 64

/** 截断后缀是 `~` + 7 位 base36 哈希；再短就装不下，直接判配置错误 */
const MIN_MAX_TOOL_NAME_LENGTH = 12

/**
 * JSON Schema 里「值是 schema」的关键字。只走这些位置，**不扫 properties 的键名**，
 * 也不扫 enum / default / const / examples —— 那些是字面值，不是 schema。
 *
 * 与 `magpie-magicrew-auth/src/hooks/loader.mjs` 的 `walkSchema` 同一套名单
 * （那份是从真实上游的 400 报错里反推出来的）。
 */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"])
const SCHEMA_ONE = new Set([
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
  "items",
  "additionalItems",
  "unevaluatedItems",
])
const SCHEMA_LIST = new Set(["allOf", "anyOf", "oneOf", "prefixItems"])

/** 「任意值」的合法写法：六种 JSON 类型全覆盖。不能用 `{type:"object"}` —— 那会收紧语义 */
const ANY_SCHEMA_TYPE = Object.freeze(["object", "string", "number", "boolean", "array", "null"])

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/**
 * 深拷贝 JSON 值（对象/数组递归，其余原样）。请求体来自 JSON.parse，
 * 不会出现 Date / Map / 函数；这里保持轻量，不依赖 structuredClone。
 */
function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone)
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, child] of Object.entries(value)) out[key] = deepClone(child)
    return out
  }
  return value
}

/** FNV-1a 32 位 → 7 位 base36。同样的名字永远得到同样的尾巴（稳定、不依赖 crypto） */
function shortHash(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).padStart(7, "0")
}

function readMaxLength(options) {
  if (options === undefined) return { ok: true, value: DEFAULT_MAX_TOOL_NAME_LENGTH }
  if (!isPlainObject(options)) return { ok: false, error: "tool-schema: options 必须是对象" }
  const max = options.maxToolNameLength ?? DEFAULT_MAX_TOOL_NAME_LENGTH
  if (!Number.isInteger(max) || max < MIN_MAX_TOOL_NAME_LENGTH) {
    return {
      ok: false,
      error: `tool-schema: maxToolNameLength 必须是 ≥${MIN_MAX_TOOL_NAME_LENGTH} 的整数，收到 ${String(max)}`,
    }
  }
  return { ok: true, value: max }
}

function readOptions(options) {
  if (options === undefined) {
    return { ok: true, value: { enabled: false, maxToolNameLength: DEFAULT_MAX_TOOL_NAME_LENGTH } }
  }
  if (!isPlainObject(options)) return { ok: false, error: "tool-schema: options 必须是对象" }
  const { enabled = false } = options
  if (typeof enabled !== "boolean") {
    return { ok: false, error: `tool-schema: enabled 必须是布尔值，收到 ${String(enabled)}` }
  }
  const max = readMaxLength(options)
  if (!max.ok) return max
  return { ok: true, value: { enabled, maxToolNameLength: max.value } }
}

/**
 * 截断单个工具名：超过 `maxToolNameLength` 时保留前缀，用 `~<hash>` 做稳定后缀。
 *
 * 这是**单名函数**，不保证跨工具唯一 —— 批量请用 {@link truncateToolNames}：
 * 两个共享长前缀的名字截出来可能同前缀，只有批量函数知道怎么加去重序号。
 *
 * 非字符串 / 非法长度原样返回（不抛，由调用方看类型判断）。
 *
 * @param {unknown} name
 * @param {number} [maxToolNameLength]
 * @returns {unknown} 截断后的字符串，或原值
 */
export function truncateToolName(name, maxToolNameLength = DEFAULT_MAX_TOOL_NAME_LENGTH) {
  if (typeof name !== "string") return name
  if (!Number.isInteger(maxToolNameLength) || maxToolNameLength < MIN_MAX_TOOL_NAME_LENGTH) return name
  if (name.length <= maxToolNameLength) return name
  const tail = `~${shortHash(name)}`
  const keep = Math.max(0, maxToolNameLength - tail.length)
  return name.slice(0, keep) + tail
}

/**
 * 批量截断工具名，并保证**结果两两不同**。
 *
 * 唯一性的两道保险：
 *   ① 先占掉所有本来就短的名字 —— 防止「长名截断后刚好撞上一个短名」
 *   ② 同一前缀 + 同哈希仍撞车时，追加 `-2` / `-3` 序号（并相应缩短前缀）
 *
 * @param {string[]} names
 * @param {{maxToolNameLength?: number}} [options]
 * @returns {{ok:true, names:string[], renamed:Record<string,string>, changed:boolean}
 *          |{ok:false, error:string}}
 */
export function truncateToolNames(names, options = {}) {
  const maxRes = readMaxLength(options)
  if (!maxRes.ok) return maxRes
  if (!Array.isArray(names)) return { ok: false, error: "truncateToolNames: names 必须是数组" }
  if (names.some((name) => typeof name !== "string")) {
    return { ok: false, error: "truncateToolNames: 每个工具名必须是字符串" }
  }

  const maxToolNameLength = maxRes.value
  const used = new Set()
  // ① 短名原样保留，先占位
  for (const name of names) {
    if (name.length <= maxToolNameLength) used.add(name)
  }

  const out = []
  const renamed = {}
  let changed = false

  for (const name of names) {
    if (name.length <= maxToolNameLength) {
      out.push(name)
      continue
    }
    let attempt = 0
    let candidate = ""
    do {
      attempt += 1
      const tail = attempt === 1 ? `~${shortHash(name)}` : `~${shortHash(name)}-${attempt}`
      const keep = maxToolNameLength - tail.length
      if (keep < 1) {
        return {
          ok: false,
          error: `tool-schema: maxToolNameLength=${maxToolNameLength} 装不下唯一性后缀（${tail}）`,
        }
      }
      candidate = name.slice(0, keep) + tail
    } while (used.has(candidate))

    used.add(candidate)
    out.push(candidate)
    renamed[name] = candidate
    changed = true
  }

  return { ok: true, names: out, renamed, changed }
}

/**
 * 在 schema 对象上原地跑 `visit`，并只递归进真正的 schema 位置。
 * 只在**深拷贝后的副本**上调用 —— 传入原对象会破坏「纯函数」承诺。
 *
 * @returns {boolean} visit 或任一子 schema 改到过
 */
function walkSchema(node, visit) {
  if (!isPlainObject(node)) return false
  let changed = visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (!value || typeof value !== "object") continue
    if (SCHEMA_MAPS.has(key) && !Array.isArray(value)) {
      for (const child of Object.values(value)) if (walkSchema(child, visit)) changed = true
      continue
    }
    if (SCHEMA_LIST.has(key) && Array.isArray(value)) {
      for (const child of value) if (walkSchema(child, visit)) changed = true
      continue
    }
    if (SCHEMA_ONE.has(key)) {
      if (Array.isArray(value)) {
        for (const child of value) if (walkSchema(child, visit)) changed = true
      } else if (walkSchema(value, visit)) {
        changed = true
      }
      continue
    }
    if (key === "dependencies" && !Array.isArray(value)) {
      for (const child of Object.values(value)) {
        if (isPlainObject(child) && walkSchema(child, visit)) changed = true
      }
    }
  }
  return changed
}

/**
 * `additionalProperties` 非布尔 → `true`。布尔值一律不动：
 * `false` 是「不许额外属性」，换成 true 语义相反，绝对不能碰。
 *
 * ⚠ 这是**降级放宽**：`{type:"string"}` 换成 true 会丢掉「额外属性必须是字符串」
 * 的约束。上游根本不支持 schema 形态，保留原值就是整个请求 400 —— 两害相权取放宽。
 */
function loosenAdditionalProperties(node) {
  return walkSchema(node, (current) => {
    if (!Object.hasOwn(current, "additionalProperties")) return false
    if (typeof current.additionalProperties === "boolean") return false
    current.additionalProperties = true
    return true
  })
}

/**
 * `items: {}` / `items: true` → 删除。JSON Schema 里 `items` 缺省就是「任意元素」，
 * 删除是**严格等价**，不是放宽。
 *
 * `items: false`（数组必须为空）语义不同，原样保留；
 * `items: {description:"x"}` 上游收，也原样保留（只删空对象 / true）。
 */
function loosenEmptyItems(node) {
  return walkSchema(node, (current) => {
    if (!Object.hasOwn(current, "items")) return false
    const value = current.items
    const emptyObject = isPlainObject(value) && Object.keys(value).length === 0
    if (!emptyObject && value !== true) return false
    delete current.items
    return true
  })
}

/** 空 schema 在 JSON Schema 里等价于 `true`（任意值），但 items 子树里上游两种都拒 */
function toAnySchema(node) {
  if (Object.keys(node).length > 0) return false
  node.type = [...ANY_SCHEMA_TYPE]
  return true
}

/** 分支是不是只声明了 null —— 取它内联会把「可选」压成「只能 null」（收紧） */
function isNullOnly(branch) {
  if (!isPlainObject(branch)) return false
  if (branch.type === "null") return true
  return Array.isArray(branch.type) && branch.type.length === 1 && branch.type[0] === "null"
}

/**
 * 在 `items` 子树里就地修：union 摊平、const/not/if 删除、空 schema 换形状。
 * 只在深拷贝后的副本上调用。
 *
 * 修法全部是**降级放宽**（宁可约束松一点，也不要整轮失败）：
 *   anyOf / oneOf / allOf → 取一个分支内联（优先非纯 null 的分支）
 *   not / const / if+then+else → 删除（无等价物）
 *   {} → `{type:[六种 JSON 类型]}`（与 {} 严格等价）
 *
 * ⚠ 两个容易漏的坑：
 *   1. 删除 `not` / `const` 后节点可能变成 `{}` —— 必须再查一次空对象，
 *      否则改完仍是 400。
 *   2. `items` 子树里的 `{}` 和 `true` 都被拒，所以「任意值」只能落成显式 type 数组。
 */
function fixItemsSubtree(node) {
  if (!isPlainObject(node)) return false
  let dirty = false

  // 空 schema {} → 显式「任意类型」（与 {} 严格等价）
  if (toAnySchema(node)) return true

  for (const [key, value] of Object.entries(node)) {
    if (key === "anyOf" || key === "oneOf" || key === "allOf") {
      if (!Array.isArray(value) || value.length === 0) {
        delete node[key]
        dirty = true
        continue
      }
      // 优先第一个非纯 null 的分支（顺序反过来时不至于把可选压成「只能 null」）
      const branch =
        value.find((item) => isPlainObject(item) && !isNullOnly(item)) ??
        value.find((item) => isPlainObject(item))
      delete node[key]
      dirty = true
      if (branch) {
        // 分支本身也可能带 union / 空 schema ⇒ 先递归修，再内联
        if (fixItemsSubtree(branch)) dirty = true
        Object.assign(node, branch)
      }
      continue
    }
    if (key === "not" || key === "const" || key === "if" || key === "then" || key === "else") {
      delete node[key]
      dirty = true
      continue
    }
    // 其余按 schema 位置递归
    if (SCHEMA_MAPS.has(key) && !Array.isArray(value)) {
      for (const child of Object.values(value)) if (fixItemsSubtree(child)) dirty = true
      continue
    }
    if (SCHEMA_LIST.has(key) && Array.isArray(value)) {
      for (const child of value) if (fixItemsSubtree(child)) dirty = true
      continue
    }
    if (SCHEMA_ONE.has(key)) {
      if (Array.isArray(value)) {
        for (const child of value) if (fixItemsSubtree(child)) dirty = true
      } else if (fixItemsSubtree(value)) {
        dirty = true
      }
    }
  }
  // 删除 not/const/if… 之后节点可能变空 —— 空 schema 在 items 子树里仍然 400，必须补
  if (toAnySchema(node)) dirty = true
  return dirty
}

/**
 * 只修 **`items` 子树内部**：上游对数组元素 schema 比根节点严，同样形态放在顶层
 * parameters 里却收。所以这条限制必须精确落在 `items` 之下，不能全局摊平 union。
 *
 * tuple 形式的 `items`（数组）落成「任意值」—— 数组里的逐位约束在这里表达不了；
 * 两站对 tuple 行为还不一致（国内收、国际拒），统一放宽。
 */
function loosenItemsSubtree(node) {
  let changed = false
  walkSchema(node, (current) => {
    if (!Object.hasOwn(current, "items")) return false
    const value = current.items
    if (Array.isArray(value)) {
      current.items = { type: [...ANY_SCHEMA_TYPE] }
      changed = true
      return false
    }
    if (!isPlainObject(value)) return false
    if (fixItemsSubtree(value)) changed = true
    return false
  })
  return changed
}

/** 对一个 schema 对象（已被深拷贝）跑全部兼容改写；返回是否改到 */
function rewriteSchemaInPlace(schema) {
  let changed = false
  if (loosenAdditionalProperties(schema)) changed = true
  if (loosenEmptyItems(schema)) changed = true
  if (loosenItemsSubtree(schema)) changed = true
  return changed
}

/**
 * 兼容改写一个 JSON Schema（工具 `parameters` 那一层）。纯函数：不改入参。
 *
 * @param {unknown} schema
 * @returns {{ok:true, schema:object, changed:boolean}|{ok:false, error:string}}
 */
export function loosenToolSchema(schema) {
  if (!isPlainObject(schema)) {
    return { ok: false, error: "loosenToolSchema: schema 必须是对象" }
  }
  const copy = deepClone(schema)
  const changed = rewriteSchemaInPlace(copy)
  return { ok: true, schema: changed ? copy : schema, changed }
}

/** 工具对象上的名字位置：chat completions 嵌在 `function.name`，Responses API 在顶层 `name` */
function toolNameOf(tool) {
  if (!isPlainObject(tool)) return null
  if (isPlainObject(tool.function) && typeof tool.function.name === "string") {
    return { name: tool.function.name, where: "function" }
  }
  if (typeof tool.name === "string" && (tool.type === "function" || isPlainObject(tool.parameters))) {
    return { name: tool.name, where: "tool" }
  }
  return null
}

/** 工具对象上的 parameters 位置（同样是两种 API 形状） */
function parametersOf(tool) {
  if (!isPlainObject(tool)) return null
  if (isPlainObject(tool.function) && isPlainObject(tool.function.parameters)) return tool.function.parameters
  if (isPlainObject(tool.parameters)) return tool.parameters
  return null
}

function setToolName(tool, where, name) {
  if (where === "function") tool.function.name = name
  else tool.name = name
}

/**
 * 适配一个 OpenAI `tools` 数组：截断函数名 + 改写每个工具的参数 schema。
 *
 * 纯函数：入参 `tools` 与里面每个工具都不动；有改动时返回深拷贝后的新数组，
 * 没改动时返回**原数组引用**（方便调用方做 identity 快路径）。
 *
 * @param {unknown} tools
 * @param {{maxToolNameLength?: number}} [options]
 * @returns {{ok:true, tools:Array, renamed:Record<string,string>, changed:boolean}
 *          |{ok:false, error:string}}
 */
export function adaptToolList(tools, options = {}) {
  const maxRes = readMaxLength(options)
  if (!maxRes.ok) return maxRes
  if (!Array.isArray(tools)) return { ok: false, error: "adaptToolList: tools 必须是数组" }

  const names = []
  const slots = []
  for (let index = 0; index < tools.length; index++) {
    const slot = toolNameOf(tools[index])
    if (!slot) continue
    names.push(slot.name)
    slots.push({ index, where: slot.where })
  }

  const namePlan = truncateToolNames(names, { maxToolNameLength: maxRes.value })
  if (!namePlan.ok) return namePlan

  const copy = deepClone(tools)
  let changed = false

  for (let i = 0; i < slots.length; i++) {
    if (names[i] === namePlan.names[i]) continue
    setToolName(copy[slots[i].index], slots[i].where, namePlan.names[i])
    changed = true
  }

  for (const tool of copy) {
    const parameters = parametersOf(tool)
    if (!parameters) continue
    if (rewriteSchemaInPlace(parameters)) changed = true
  }

  return { ok: true, tools: changed ? copy : tools, renamed: namePlan.renamed, changed }
}

/** `tool_choice` 里如果指名了某个被截断的工具，跟着改 —— 否则强制调用会指向不存在的名字 */
function renameToolChoice(body, renamed) {
  const choice = body.tool_choice
  if (!isPlainObject(choice)) return body
  let oldName = null
  let where = null
  if (isPlainObject(choice.function) && typeof choice.function.name === "string") {
    oldName = choice.function.name
    where = "function"
  } else if (typeof choice.name === "string") {
    oldName = choice.name
    where = "tool"
  }
  const newName = oldName !== null ? renamed[oldName] : undefined
  if (!newName) return body
  const next = { ...body, tool_choice: deepClone(choice) }
  if (where === "function") next.tool_choice.function.name = newName
  else next.tool_choice.name = newName
  return next
}

function rewriteBodyObject(body, maxToolNameLength) {
  if (!isPlainObject(body) || !Array.isArray(body.tools)) return body
  const result = adaptToolList(body.tools, { maxToolNameLength })
  if (!result.ok || !result.changed) return body
  return renameToolChoice({ ...body, tools: result.tools }, result.renamed)
}

/**
 * 改写一个完整请求体：`body` 可以是已经 parse 的对象，也可以是原始 JSON 字符串。
 *
 * 默认关闭：`options.enabled !== true` 时**原样返回入参**。开启后如无实际改动，
 * 也返回原引用 / 原字符串（不白复制、不白序列化）。坏 JSON、非对象 body、
 * 没有 `tools` 数组都原样返回 —— 这个模块只做工具定义适配，不替上游判断别的错误。
 *
 * @param {unknown} body
 * @param {{enabled?: boolean, maxToolNameLength?: number}} [options]
 * @returns {unknown}
 */
export function rewriteToolSchema(body, options = {}) {
  const config = readOptions(options)
  if (!config.ok || !config.value.enabled) return body

  if (typeof body === "string") {
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      return body
    }
    const next = rewriteBodyObject(parsed, config.value.maxToolNameLength)
    return next === parsed ? body : JSON.stringify(next)
  }

  return rewriteBodyObject(body, config.value.maxToolNameLength)
}

/**
 * 工厂：把配置烘进一个 adapter。**默认关闭** —— 这是本模块唯一推荐的接法，
 * 调用方必须显式传 `{ enabled: true }` 才会改写任何东西。
 *
 * 返回对象而不是裸函数，是为了把「配置是否合法」也用返回值说清楚：
 * `error` 非 null 时 `enabled` 一律为 false，`adapt` 退化成 identity。
 *
 * @param {{enabled?: boolean, maxToolNameLength?: number}} [options]
 * @returns {{enabled:boolean, error:string|null, adapt:(body:unknown)=>unknown}}
 */
export function createToolSchemaAdapter(options = {}) {
  const config = readOptions(options)
  if (!config.ok) {
    return { enabled: false, error: config.error, adapt: (body) => body }
  }
  const { enabled, maxToolNameLength } = config.value
  return {
    enabled,
    error: null,
    adapt(body) {
      if (!enabled) return body
      return rewriteToolSchema(body, { enabled: true, maxToolNameLength })
    },
  }
}
