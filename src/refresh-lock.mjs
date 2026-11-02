// src/refresh-lock.mjs —— 一次性 refresh_token 的并发闸
//
// 为什么必须有它：refresh_token **一次性**的厂商，同账号并发刷新两次时，
// 第二次会拿着已经被轮换掉的旧 token 去换 —— 结果不是「慢一点」，而是
// 「登录莫名失效」。宿主自己的 `auth.refresh` 与请求链路可能同时触发刷新，
// 所以插件侧必须把同一次刷新合并成一次。
//
// 模式来源（都是 MIT）：
//   · magpie-officeace/src/login.mjs:292-310 —— `refreshOnce`，键 = refreshToken
//   · magpie-magicrew-auth/src/key-store.mjs:171-188 —— `renewOnce`，键 = siteId + account
//   · @magpie-community/opencode-raccoon-auth/index.mjs:228-286 —— renewing + renewed 双 Map，结果回放 60 秒
//
// 本模块只保留协议原语：存储、厂商刷新函数、账号解析都由调用方注入。

const DEFAULT_REPLAY_MS = 60_000

/**
 * 建一个按 key 合并并发的刷新闸。
 *
 * @param {{replayMs?: number}} [options]
 *   replayMs：成功结果在内存里保留多久（毫秒）。0 表示不回放。
 * @returns {{
 *   run(key: string, fn: () => unknown | Promise<unknown>): Promise<unknown>,
 *   clear(key: string): void,
 *   readonly size: number,
 *   readonly pending: number,
 * }}
 */
export function createRefreshLock({ replayMs = DEFAULT_REPLAY_MS } = {}) {
  if (typeof replayMs !== "number" || !Number.isFinite(replayMs) || replayMs < 0) {
    throw new TypeError(`createRefreshLock: replayMs 必须是非负有限数字，收到 ${replayMs}`)
  }

  /** @type {Map<string, Promise<unknown>>} */
  const inflight = new Map()
  /** @type {Map<string, { value: unknown, expiresAt: number }>} */
  const replay = new Map()

  function assertKey(key) {
    if (typeof key !== "string" || key.trim() === "") {
      throw new TypeError(
        "refresh lock 的 key 必须是非空字符串 —— 键必须来自凭据身份（如 refresh_token），不能用 provider id，" +
          "否则同渠道的多个账号会共享同一次刷新结果",
      )
    }
  }

  /** 清掉所有已过期的回放项。每次 run 前调用一次，避免账号多时 Map 无界增长。 */
  function sweep() {
    const at = Date.now()
    let removed = 0
    for (const [key, entry] of replay) {
      if (entry.expiresAt <= at) {
        replay.delete(key)
        removed += 1
      }
    }
    return removed
  }

  return {
    run(key, fn) {
      assertKey(key)
      if (typeof fn !== "function") throw new TypeError("refresh lock 的 fn 必须是函数")

      sweep() // 顺手清理过期项，避免 replay Map 只增不减

      // ① 成功结果短回放：宿主 auth.refresh 与请求链路各花一次旧 token 的常见场景
      const cached = replay.get(key)
      if (cached) {
        if (cached.expiresAt > Date.now()) return Promise.resolve(cached.value)
        replay.delete(key)
      }

      // ② 同一 key 的 in-flight 合并：所有等待者拿到同一个 promise（同一个错误对象）
      const pending = inflight.get(key)
      if (pending) return pending

      let task = Promise.resolve()
        .then(fn)
        .then((value) => {
          replay.set(key, { value, expiresAt: Date.now() + replayMs })
          return value
        })
      // 失败不缓存：finally 只清理 in-flight，下一次调用会重新执行
      task = task.finally(() => {
        if (inflight.get(key) === task) inflight.delete(key)
      })
      inflight.set(key, task)
      return task
    },

    /**
     * 只清成功回放，不动 in-flight：那次刷新还在花同一个 refresh_token，
     * 清掉 in-flight 会让新调用再发一次，正是本模块要防的事。
     */
    clear(key) {
      assertKey(key)
      replay.delete(key)
    },

    /** 显式清理过期回放项，返回清理条数（诊断用） */
    sweep,

    /** 回放缓存条数（测试与诊断用） */
    get size() {
      return replay.size
    },

    /** 正在执行的刷新次数（测试与诊断用） */
    get pending() {
      return inflight.size
    },
  }
}
