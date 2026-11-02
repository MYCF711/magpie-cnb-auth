// src/oauth-pkce.mjs —— OAuth 2.0 PKCE + 本机 loopback 回调（厂商无关原语）
//
// 为什么单独一个模块：OAuth 授权码流程 + PKCE 是标准协议，但「在本机随机端口
// 收一次性回调」这件事每个插件都重写一遍，且都很容易漏掉 state 校验、超时、
// Host 校验与错误页。这里只提供协议原语，**不接任何厂商端点**：
// authorizeUrl / clientId / scope / tokenUrl 全部由调用方注入。
//
// 模式来源（都是 MIT）：
//   · magpie-trustoken-auth/src/oauth.mjs:31-149 —— beginOAuth / PKCE S256 / 随机端口回调
//   · @magpie-community/opencode-raccoon-auth/index.mjs:862-926 —— state 单值校验、Host 校验、
//     单次回调、CSP default-src 'none'（本模块按同一安全边界实现）
//
// 安全边界（不要为了「方便」删掉其中任何一条）：
//   · 只绑定 127.0.0.1，且校验 Host 必须是 127.0.0.1:<port>（防 DNS rebinding）
//   · state 必须**恰好出现一次**且与创建时一致；错的回调返回 400 但**不结束流程**
//     （用户可能有一个无关页面撞到这个端口；正确回调还可能随后到达）
//   · 只接受 GET；错误 path 返回 404，不影响等待
//   · 回调页面带 CSP `default-src 'none'`、`Cache-Control: no-store`、`Referrer-Policy: no-referrer`
//   · 超时 / AbortSignal / close() 都会 reject 并释放端口

import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"

const DEFAULT_TIMEOUT_MS = 300_000
const MAX_CODE_LENGTH = 4096

/** 生成 PKCE verifier / challenge（S256）。verifier 是 43 个 base64url 字符。 */
export function generatePkce() {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge, method: "S256" }
}

/** 随机 state（base64url）。CSRF 防护用，不要用可预测的计数器。 */
export function randomState() {
  return randomBytes(32).toString("base64url")
}

function renderPage(title, body) {
  return (
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">` +
    `<h2>${title}</h2><p>${body}</p></body>`
  )
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason
  return new DOMException("The operation was aborted.", "AbortError")
}

function assertPositiveNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} 必须是正数，收到 ${value}`)
  }
}

/**
 * 启动本机 loopback OAuth 回调服务器。
 *
 * @param {{
 *   state: string,
 *   path?: string,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   successHtml?: string | ((ctx: object) => string),
 *   failureHtml?: string | ((ctx: object) => string),
 * }} options
 * @returns {Promise<{
 *   redirectUri: string,
 *   port: number,
 *   wait: () => Promise<{ code: string, state: string, query: Record<string, string> }>,
 *   close: () => void,
 * }>}
 */
export async function startLoopback({
  state,
  path = "/oauth/callback",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  successHtml,
  failureHtml,
} = {}) {
  if (typeof state !== "string" || state.trim() === "") {
    throw new TypeError("startLoopback: state 必须是非空字符串（先用 randomState() 生成）")
  }
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new TypeError(`startLoopback: path 必须以 / 开头，收到 ${path}`)
  }
  assertPositiveNumber(timeoutMs, "startLoopback: timeoutMs")

  const okPage =
    successHtml ?? renderPage("登录完成", "可以关闭这个窗口，回到 magpie。")
  const failPage =
    failureHtml ?? renderPage("登录未完成", "请回到 magpie 查看错误后重新登录。")

  const page = (value, ctx) => {
    if (typeof value === "function") return String(value(ctx))
    return String(value)
  }

  /** @type {import("node:http").Server | undefined} */
  let server
  let port = 0
  let timer = null
  /** @type {{ ok: boolean, value: any } | null} */
  let settled = null
  /** @type {{ resolve: Function, reject: Function }[]} */
  const waiters = []

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    signal?.removeEventListener("abort", onAbort)
    try {
      server?.close()
    } catch {}
    try {
      server?.closeIdleConnections?.()
    } catch {}
  }

  const settle = (ok, value) => {
    if (settled) return
    settled = { ok, value }
    cleanup()
    for (const waiter of waiters.splice(0)) {
      if (ok) waiter.resolve(value)
      else waiter.reject(value)
    }
  }

  const onAbort = () => settle(false, abortError(signal))

  server = createServer((req, res) => {
    const reply = (status, text, type = "text/html; charset=utf-8") => {
      if (res.writableEnded) return
      res.writeHead(status, {
        "content-type": type,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'",
        connection: "close",
      })
      res.end(text)
    }

    try {
      if (req.method !== "GET") return reply(405, "Method not allowed", "text/plain; charset=utf-8")
      if (req.headers.host !== `127.0.0.1:${port}`) return reply(404, "Not found", "text/plain; charset=utf-8")

      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      if (url.pathname !== path) return reply(404, "Not found", "text/plain; charset=utf-8")

      const query = Object.fromEntries(url.searchParams)
      const states = url.searchParams.getAll("state")
      if (states.length !== 1 || states[0] !== state) {
        // 不是本次登录的回调：400，但**不结束等待**（正确回调可能随后到）
        return reply(400, page(failPage, { error: "state_mismatch", query }))
      }

      const error = url.searchParams.get("error")
      if (error) {
        const message = `OAuth 返回错误：${error}${url.searchParams.get("error_description") ? `（${url.searchParams.get("error_description")}）` : ""}`
        reply(400, page(failPage, { error, query }))
        return settle(false, new Error(message))
      }

      const codes = url.searchParams.getAll("code")
      const code = codes[0] ?? ""
      if (codes.length !== 1 || code === "" || code.length > MAX_CODE_LENGTH) {
        reply(400, page(failPage, { error: "invalid_code", query }))
        return settle(false, new Error("OAuth 回调缺少有效 code"))
      }

      reply(200, page(okPage, { code, state: states[0], query }))
      settle(true, { code, state: states[0], query })
    } catch (e) {
      reply(500, page(failPage, { error: "internal_error" }))
      settle(false, e instanceof Error ? e : new Error(String(e)))
    }
  })

  await new Promise((resolve, reject) => {
    // listen 之后**不要移除** error 监听：运行期 server 也可能 emit error（例如底层 socket 异常），
    // 没有监听器会变成 uncaughtException。启动期 reject，运行期把等待者 reject 掉。
    let listening = false
    server.on("error", (error) => {
      if (!listening) reject(error)
      else settle(false, error)
    })
    server.listen(0, "127.0.0.1", () => {
      listening = true
      resolve()
    })
  })

  port = server.address().port

  if (signal?.aborted) {
    settle(false, abortError(signal))
  } else {
    signal?.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(
      () => settle(false, new Error(`OAuth 登录超时（${Math.round(timeoutMs / 1000)} 秒）`)),
      timeoutMs,
    )
    timer.unref?.()
  }

  return {
    redirectUri: `http://127.0.0.1:${port}${path}`,
    port,
    wait() {
      if (settled) {
        return settled.ok ? Promise.resolve(settled.value) : Promise.reject(settled.value)
      }
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
    },
    close() {
      if (settled) {
        try {
          server?.close()
        } catch {}
        return
      }
      settle(false, new Error("OAuth loopback 已关闭"))
    },
  }
}
