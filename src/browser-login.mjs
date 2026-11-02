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
        // ⚠ 必须显式给 stdio：默认子进程 stderr 是**继承**的，而 `reg query` 查不到项时
        //   会往 stderr 写「错误: 系统找不到指定的注册表项或值。」—— 实测一次 findBrowser()
        //   能刷出 20 多行中文噪声，直接进 magpie 的插件日志。stdout 仍要 pipe（要读 REG_SZ）。
        const out = execFileSync("reg", ["query", `${root}\\${tail}`, "/ve"], {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
        })
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
 * 「现在可以收工了吗？」
 *
 * 默认只看「cookie 齐了没有」；给了 `waitFor` 就变成「cookie 齐了**且** `waitFor` 说可以」。
 *
 * ⚠ 抽成纯函数是为了能离线测：真的要验它得开一个 GUI 浏览器，跑不进单测。
 *   而「cookie 齐了也不算完」恰恰是最容易写反的一条（写成 `||` 就等于没等）。
 *
 * ⚠ `waitFor` 自己抛就让它冒泡 —— 那是调用方的 bug 或用户取消，不该被吞成「继续等」。
 *
 * @param {{cookieNames?:string[], header?:string, found?:Record<string,string>, waitFor?:(found:Record<string,string>)=>Promise<boolean>|boolean}} [o]
 * @returns {Promise<boolean>}
 */
export async function readyToFinish({ cookieNames = [], header = "", found = {}, waitFor } = {}) {
  // cookieNames 为空表示「随便有个非空 cookie 就算」（与改动前的语义一致）
  const cookiesOk = cookieNames.length === 0 ? header.length > 0 : cookieNames.every((n) => found[n])
  if (!cookiesOk) return false
  if (typeof waitFor !== "function") return true
  return Boolean(await waitFor(found))
}

/**
 * 一轮一轮读到「可以收工」为止。
 *
 * 抽出来只为一件事：`chromiumLogin` 的其余部分（找端口 / 开窗 / 关窗 / 删 profile）必须真起
 * 浏览器，而这一段用假的 `readCookies` 就能测 —— 包括 `waitFor` 的语义。
 *
 * @param {object} o
 * @param {() => Promise<object[]>} o.readCookies 读一次 cookie 列表
 * @param {string[]} [o.cookieNames]
 * @param {number} [o.deadline] 绝对截止时间（毫秒时间戳）
 * @param {number} [o.stepMs] 每轮间隔，默认 1 秒
 * @param {AbortSignal} [o.signal]
 * @param {(found:Record<string,string>)=>Promise<boolean>|boolean} [o.waitFor]
 * @returns {Promise<{cookie:string, found:Record<string,string>}>}
 */
export async function pollCookies({
  readCookies,
  cookieNames = [],
  deadline = Date.now() + 5 * 60_000,
  stepMs = 1000,
  signal,
  waitFor,
} = {}) {
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("登录已取消")
    // 读失败（CDP 断线、页面切换）当成「这一轮没有」，与改动前一致
    const cookies = await Promise.resolve().then(readCookies).catch(() => [])
    const { header, found } = selectCookies(cookies, cookieNames)
    if (await readyToFinish({ cookieNames, header, found, waitFor })) return { cookie: header, found }
    await new Promise((r) => setTimeout(r, stepMs))
  }
  throw new Error(`登录超时：没有拿到 ${cookieNames.join(" / ")}`)
}

/**
 * 打开受控浏览器，等用户登录，返回需要的 Cookie。
 *
 * @param {object} o
 * @param {{name:string,path:string}} o.browser findBrowser() 的返回值
 * @param {string} o.url 登录页
 * @param {string[]} [o.cookieNames] 必须拿到的 cookie 名
 * @param {number} [o.timeoutMs] 默认 5 分钟（从开窗算起，含等调试端口的时间）
 * @param {AbortSignal} [o.signal]
 * @param {(found:Record<string,string>) => Promise<boolean>|boolean} [o.waitFor]
 *   给「抓 Cookie 的同时还要等另一件事完成」的调用方用 —— 例如同一个窗口里还要走
 *   OAuth 设备码，得等用户点完「确认授权」。返回 false 就继续等（1 秒一轮），
 *   直到它返回 true 或超时/取消。传 `undefined` 时行为与以前完全一致：cookie 齐了就返回。
 * @returns {Promise<{cookie:string, found:Record<string,string>, browser:string}>}
 */
export async function chromiumLogin({ browser, url, cookieNames = [], timeoutMs = 5 * 60_000, signal, waitFor }) {
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
    // ⚠ 临时 profile 每次都是「新装」，Edge 会先弹一个**模态的同步确认对话框**
    //   （实测 2026-11-03：CDP 的页面列表里多出 `edge://sync-confirmation-dialog/`，
    //   标题「我们现在正在你的所有设备上同步你的浏览数据」），它会盖在登录页上面，
    //   用户得先点掉才能看到 cnb.cool —— 而他本来只是来登录的。
    //   Chrome 不认这几个 Edge 专属 feature 名，会直接忽略，不会因此出错。
    "--disable-sync",
    "--disable-features=msEdgeSyncPromo,msEdgeSignInPromo,msImplicitSignin",
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

    // ⚠ 轮询沿用同一个 deadline：等调试端口的那几十秒也算进 `timeoutMs` 里，
    //   否则「开窗」和「等 cookie」各等 5 分钟，用户会干等 10 分钟。
    const { cookie, found } = await pollCookies({
      readCookies: () => cdpCookies(pageWs),
      cookieNames,
      deadline,
      signal,
      waitFor,
    })
    return { cookie, found, browser: browser.name }
  } finally {
    cleanup()
  }
}

export const _internal = { WIN_EXES, freePort, cdpCookies }
