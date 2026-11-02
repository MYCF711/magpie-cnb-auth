// src/models.mjs —— 每账号的模型目录
//
// CNB **没有公开的 `/models` 端点**：可选的模型就是那几个，而且不因账号而异。
// 所以这个钩子的任务不是「拉目录」，而是「按这个账号的通道，把能力标对」：
//
//   relay  通道 → toolcall: true   （中继自己支持工具）
//   cookie 通道 → toolcall: false  （上游结构性拒绝 tools，标 true 就是假声明）
//   未登录      → 保持 config 里的乐观值，等登录后再纠正
//
// ⚠ 三态降级在这里不适用：没有「接口失败」这一态，因为没有接口。
//   不要为了凑形态去编一个 fetch —— 那会让「拉取失败退回快照」的语义变成假的。

import { MODEL_SPECS, modelEntry } from "./context.mjs"

/**
 * 组装模型表。
 *
 * @param {object} provider  宿主传进来的 provider 条目（里面有 config 钩子给的 models）
 * @param {object} opts
 * @param {string} opts.transport  "relay" | "cookie" | "none"
 */
export function buildModels(provider, { transport = "none" } = {}) {
  const configured = provider?.models && typeof provider.models === "object" ? provider.models : {}
  const toolcall = transport !== "cookie"

  const out = {}
  for (const spec of MODEL_SPECS) {
    const base = configured[spec.id] || {}
    const entry = modelEntry(spec, { toolcall })
    out[spec.id] = {
      ...entry,
      ...base,
      id: base.id || entry.id,
      name: base.name || entry.name,
      // limit 以实测的静态表为准，但允许用户手动覆盖（base 在后）
      limit: { ...entry.limit, ...(base.limit || {}) },
      capabilities: { ...entry.capabilities, ...(base.capabilities || {}) },
      api: { ...entry.api, ...(base.api || {}), id: base.api?.id || entry.api.id },
    }
    // 通道不支持 tools 时，把两个拼写都纠正过来：
    // 模型条目读 `capabilities.toolcall`，config 路径读 `tool_call`。
    if (!toolcall) {
      out[spec.id].capabilities = { ...out[spec.id].capabilities, toolcall: false }
      out[spec.id].tool_call = false
    }
  }
  return out
}

/** 这个 provider 条目里有没有我们不认识的模型（用户自己加的）——原样保留。 */
export function keepUnknownModels(provider, models) {
  const configured = provider?.models && typeof provider.models === "object" ? provider.models : {}
  const out = { ...models }
  for (const [id, entry] of Object.entries(configured)) {
    if (!out[id] && entry && typeof entry === "object") out[id] = entry
  }
  return out
}
