// src/model-context.mjs —— 从 magpie 自己的模型库查上下文窗口（厂商无关）
//
// 为什么不能自己填一个数：填小了 agent 会提前压缩（真实事故：一律填 256K，实际 1M，
// `pi-ai detected context overflow`）；填大了上游 400，而那个 400 还会被当成
// 「模型不可用」。magpie 已经有一份按厂商分组的模型库（`~/.cache/magpie/models.json`，
// 每条带 `limit.context`），向它查，不要猜。
//
// 模式来源（MIT）：magpie-magicrew-auth/src/model-context.mjs:35-100。
//
// 与来源实现的差别：本模块**没有 1M 兜底** —— 查不到就返回调用方给的 fallback；
// 没给 fallback 就返回 undefined。把「不知道」如实说出来，比编一个数字安全。

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const DEFAULT_CACHE_MS = 10 * 60_000
export const DEFAULT_LIBRARY_PATH = join(homedir(), ".cache", "magpie", "models.json")

function buildIndex(node, state) {
  if (Array.isArray(node)) {
    for (const value of node) buildIndex(value, state)
    return
  }
  if (!node || typeof node !== "object") return

  const id = typeof node.id === "string" ? node.id.trim() : ""
  const raw = node.limit?.context ?? node.context_length ?? node.context_window
  const context = Number(raw)
  if (id && Number.isFinite(context) && context > 0) {
    const key = id.toLowerCase()
    // 完全相同的 id 出现在多个厂商下：取最大（那才是它真能收的）
    const prev = state.exact.get(key) ?? 0
    if (context > prev) state.exact.set(key, context)
    state.entries.push({ key, context })

    const tail = key.split("/").pop()
    if (tail) {
      const tailKey = `~${tail}`
      const prevTail = state.tails.get(tailKey) ?? 0
      if (context > prevTail) state.tails.set(tailKey, context)
    }
  }

  for (const value of Object.values(node)) buildIndex(value, state)
}

/**
 * 建一个模型库查询器。
 *
 * @param {{
 *   libraryPath?: string,
 *   cacheMs?: number,
 *   readFile?: (path: string, encoding: string) => string | Buffer,
 *   now?: () => number,
 * }} [options]
 */
export function createModelContext({
  libraryPath = DEFAULT_LIBRARY_PATH,
  cacheMs = DEFAULT_CACHE_MS,
  readFile = readFileSync,
  now = Date.now,
} = {}) {
  if (typeof readFile !== "function") throw new TypeError("createModelContext: readFile 必须是函数")
  if (typeof now !== "function") throw new TypeError("createModelContext: now 必须是函数")
  if (typeof cacheMs !== "number" || !Number.isFinite(cacheMs) || cacheMs < 0) {
    throw new TypeError(`createModelContext: cacheMs 必须是非负有限数字，收到 ${cacheMs}`)
  }

  /** @type {{ exact: Map<string, number>, tails: Map<string, number>, entries: { key: string, context: number }[] } | null} */
  let index = null
  let loadedAt = 0

  function load() {
    const at = now()
    if (index && at - loadedAt < cacheMs) return index

    const state = { exact: new Map(), tails: new Map(), entries: [] }
    let raw = null
    try {
      raw = readFile(libraryPath, "utf8")
    } catch {
      // 文件不存在 / 没权限：不是错误，就是查不到
      raw = null
    }
    if (raw != null) {
      try {
        buildIndex(JSON.parse(String(raw)), state)
      } catch {
        // 坏 JSON 与不存在等价：清空索引，不抛
        state.exact.clear()
        state.tails.clear()
        state.entries.length = 0
      }
    }

    index = state
    loadedAt = at
    return index
  }

  function validFallback(value) {
    if (value == null || value === "") return undefined
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }

  return {
    /**
     * 查一个模型 id 的上下文窗口。
     * 命中顺序：精确 id → 尾段 → 同尾段跨厂商取最大 → fallback。
     * 查不到且 fallback 不是合法正数 → undefined（不猜）。
     */
    contextOf(modelId, { fallback } = {}) {
      const fallbackValue = validFallback(fallback)
      const id = String(modelId ?? "")
        .trim()
        .toLowerCase()
      if (!id) return fallbackValue

      const idx = load()
      const exact = idx.exact.get(id)
      if (exact !== undefined) return exact

      const tail = id.split("/").pop()
      const tailHit = idx.tails.get(`~${tail}`)
      if (tailHit !== undefined) return tailHit

      // 兜底：库里的 id 可能带任意厂商前缀（`Pro/deepseek-ai/x` 之类）
      let best = 0
      for (const entry of idx.entries) {
        if (entry.key.endsWith(`/${id}`) || entry.key.endsWith(`/${tail}`)) {
          if (entry.context > best) best = entry.context
        }
      }
      return best > 0 ? best : fallbackValue
    },

    /** 丢掉缓存，下一次调用重新读文件 */
    clear() {
      index = null
      loadedAt = 0
    },

    /** 索引里唯一模型 id 的数量（读取即触发加载） */
    get size() {
      return load().exact.size
    },
  }
}

let defaultContext = null

/**
 * 默认实例：读 `~/.cache/magpie/models.json`，10 分钟缓存。
 * 这是 `src/models.mjs` 的 `contextOf()` 背后用的实现。
 */
export function contextOf(modelId, opts = {}) {
  defaultContext ??= createModelContext()
  return defaultContext.contextOf(modelId, opts)
}

/** 测试用：重置默认实例（生产代码不要调）。 */
export function _resetDefaultContext() {
  defaultContext = null
}
