// src/browser-login.mjs —— 打开一个受控 Chromium 窗口，让用户正常登录，再从 CDP 取 Cookie
//
// 什么时候用：厂商没有 OAuth 回调、也没有桌面客户端可导入，但网页登录后 Cookie 就是凭据。
// 比「让用户自己 F12 复制 Cookie」可靠：用户只需要在窗口里登录一次。
//
// 设计取舍（来自 WPS 灵犀 0.4.11 的实测实现，MIT；见 NOTICE.md）：
//   · 任意 Chromium 内核浏览器都行（Chrome / Edge / 360 / QQ / Brave / Vivaldi…），
//     不止 Chrome；国产浏览器在 Windows 上很常见，漏了它们这条登录路对用户就不存在。
//   · Windows 的候选顺序：Chrome → 国产 Chromium → Edge 最后（Edge 策略最多、最容易被组织禁用）。
//   · 用一次性 user-data-dir，不碰用户日常浏览器配置；登录态只在本次窗口里。
//   · 退出码不可靠：浏览器可能把调试参数吞掉，所以以「CDP 端口能不能连上」为准。
//
// ⚠ 只读 Cookie，不写浏览器数据；窗口关闭后临时 profile 会被删掉。
// ⚠ 本模块不依赖任何第三方包；Node 22+ 的全局 WebSocket 足够。

import { spawn } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import { execFileSync } from "node:child_process"

const WIN_EXES = [
  "chrome.exe",
  "360ChromeX.exe",
  "360chrome.exe",
  "360se.exe",
  "QQBrowser.exe",
  "Brave.exe",
  "vivaldi.exe",
  "opera.exe",
  "SogouExplorer.exe",
  "2345Explorer.exe",
  "liebao.exe",
  "Maxthon.exe",
  "UCBrowser.exe",
  "Quark.exe",
  "msedge.exe",
]

/** Windows 注册表 App Paths 查浏览器；查不到返回空串。 */
export function registryAppPath(exe) {
  if (process.platform !== "win32") return ""
  for (const root of ["HKCU", "HKLM"]) {
    for (const tail of [
      `SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
      `SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    ]) {
      try {
        const out = execFileSync("reg", ["query", `${root}\\${tail}`, "/ve"], { encoding: "utf8", timeout: 5000 })
        const line = out.split("\n").find((l) => /REG_SZ/i.test(l))
        const path = line?.split("REG_SZ")[1]?.trim()
        if (path && existsSync(path)) return path
      } catch {}
    }
  }
  return ""
}

/**
 * 候选浏览器（按优先级）。不做存在性检查，方便测试与排序。
 * @param {{platform?:string, env?:Record<string,string>, lookup?:(exe:string)=>string}} [o]
 * @returns {{name:string, path:string}[]}
 */
export function browserCandidates({ platform = process.platform, env = process.env, lookup = registryAppPath } = {}) {
  const h = env.HOME || env.USERPROFILE || ""
  const local = env.LOCALAPPDATA || ""
  const roaming = env.APPDATA || ""
  const pf = env.PROGRAMFILES || ""
  const pf86 = env["PROGRAMFILES(X86)"] || env["ProgramFiles(x86)"] || ""
  const add = (list, name, path) => {
    if (path) list.push({ name, path })
  }

  if (platform === "win32") {
    const list = []
    for (const exe of WIN_EXES) {
      const fromRegistry = lookup(exe)
      if (fromRegistry) add(list, exe.replace(/\.exe$/i, ""), fromRegistry)
    }
    add(list, "Chrome", join(pf, "Google", "Chrome", "Application", "chrome.exe"))
    add(list, "Chrome", join(pf86, "Google", "Chrome", "Application", "chrome.exe"))
    add(list, "Chrome", join(local, "Google", "Chrome", "Application", "chrome.exe"))
    add(list, "Chromium", join(local, "Chromium", "Application", "chrome.exe"))
    add(list, "Chromium", join(pf, "Chromium", "Application", "chrome.exe"))
    add(list, "360极速浏览器X", join(local, "360ChromeX", "Chrome", "Application", "360ChromeX.exe"))
    add(list, "360浏览器", join(local, "360Chrome", "Chrome", "Application", "360chrome.exe"))
    add(list, "360安全浏览器", join(roaming, "secoresdk", "360se6", "Application", "360se.exe"))
    add(list, "QQ浏览器", join(local, "Tencent", "QQBrowser", "Application", "QQBrowser.exe"))
    add(list, "Brave", join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"))
    add(list, "Brave", join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"))
    add(list, "Vivaldi", join(local, "Vivaldi", "Application", "vivaldi.exe"))
    add(list, "Opera", join(local, "Programs", "Opera", "opera.exe"))
    add(list, "Opera", join(roaming, "Opera Software", "Opera Stable", "opera.exe"))
    add(list, "搜狗浏览器", join(local, "SogouExplorer", "SogouExplorer.exe"))
    add(list, "2345浏览器", join(local, "2345Explorer", "2345Explorer.exe"))
    add(list, "猎豹浏览器", join(local, "liebao", "liebao.exe"))
    add(list, "Maxthon", join(roaming, "Maxthon3", "Bin", "Maxthon.exe"))
    add(list, "UC浏览器", join(local, "UCBrowser", "Application", "UCBrowser.exe"))
    add(list, "夸克浏览器", join(local, "Quark", "Quark.exe"))
    add(list, "Edge", join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"))
    add(list, "Edge", join(pf, "Microsoft", "Edge", "Application", "msedge.exe"))
    return dedupe(list)
  }

  if (platform === "darwin") {
    return [
      ["Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
      ["Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
      ["Brave", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
      ["Vivaldi", "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi"],
      ["Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    ].map(([name, path]) => ({ name, path }))
  }

  return [
    ["Chrome", join(h, ".config/google-chrome/chrome")],
    ["Chromium", join(h, ".config/chromium/chrome")],
    ["Brave", join(h, ".config/BraveSoftware/Brave-Browser/brave")],
    ["Vivaldi", join(h, ".config/vivaldi/vivaldi")],
    ["Edge", join(h, ".config/microsoft-edge/msedge")],
  ].map(([name, path]) => ({ name, path }))
}

function dedupe(list) {
  const seen = new Set()
  return list.filter((x) => {
    const key = x.path.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 第一个真实存在的候选；没有返回 null。 */
export function findBrowser({ platform = process.platform, env = process.env, exists = existsSync, lookup = registryAppPath } = {}) {
  return browserCandidates({ platform, env, lookup }).find((b) => exists(b.path)) ?? null
}

/** 从 CDP 的 cookie 列表里挑需要的名字；返回 header 字符串与命中的键。 */
export function selectCookies(cookies, names) {
  const want = new Set(names)
  const found = {}
  for (const c of cookies ?? []) {
    if (!c?.name || !want.has(c.name)) continue
    if (typeof c.value !== "string" || c.value === "") continue
    found[c.name] = c.value
  }
  return { header: Object.entries(found).map(([k, v]) => `${k}=${v}`).join("; "), found }
}

/** 等一个文件出现；超时返回 false，不抛。 */
export async function waitForFile(file, timeoutMs = 30_000, stepMs = 200) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (existsSync(file)) return true
    await new Promise((r) => setTimeout(r, stepMs))
  }
  return false
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

async function getJson(url, timeoutMs = 5000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function cdpSend(ws, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      let msg
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (msg.id !== id) return
      ws.removeEventListener("message", onMessage)
      if (msg.error) reject(new Error(msg.error.message || "CDP error"))
      else resolve(msg.result)
    }
    ws.addEventListener("message", onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function cdpCookies(pageWsUrl) {
  const ws = new WebSocket(pageWsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true })
    ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连不上")), { once: true })
  })
  try {
    await cdpSend(ws, 1, "Network.enable")
    const result = await cdpSend(ws, 2, "Network.getAllCookies")
    return result?.cookies ?? []
  } finally {
    try { ws.close() } catch {}
  }
}

/**
 * 打开受控浏览器，等用户登录，返回需要的 Cookie。
 *
 * @param {object} o
 * @param {{name:string,path:string}} o.browser findBrowser() 的返回值
 * @param {string} o.url 登录页
 * @param {string[]} [o.cookieNames] 必须拿到的 cookie 名
 * @param {number} [o.timeoutMs] 默认 5 分钟
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{cookie:string, found:Record<string,string>, browser:string}>}
 */
export async function chromiumLogin({ browser, url, cookieNames = [], timeoutMs = 5 * 60_000, signal }) {
  if (!browser?.path) throw new Error("没有可用的 Chromium 浏览器")
  const profile = mkdtempSync(join(tmpdir(), "magpie-login-"))
  const port = await freePort()
  const child = spawn(browser.path, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    url,
  ], { stdio: "ignore", windowsHide: false })

  const cleanup = () => {
    try { child.kill() } catch {}
    try { rmSync(profile, { recursive: true, force: true }) } catch {}
  }
  const deadline = Date.now() + timeoutMs
  try {
    let pageWs = ""
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("登录已取消")
      try {
        const pages = await getJson(`http://127.0.0.1:${port}/json/list`, 1000)
        pageWs = pages.find((p) => p.type === "page" && p.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? ""
        if (pageWs) break
      } catch {}
      await new Promise((r) => setTimeout(r, 300))
    }
    if (!pageWs) throw new Error("受控浏览器没有打开调试端口（浏览器可能吞掉了 --remote-debugging-port）")

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("登录已取消")
      const cookies = await cdpCookies(pageWs).catch(() => [])
      const { header, found } = selectCookies(cookies, cookieNames)
      const ok = cookieNames.length === 0 ? header.length > 0 : cookieNames.every((n) => found[n])
      if (ok) return { cookie: header, found, browser: browser.name }
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error(`登录超时：没有拿到 ${cookieNames.join(" / ")}`)
  } finally {
    cleanup()
  }
}

export const _internal = { WIN_EXES, freePort, cdpCookies }
