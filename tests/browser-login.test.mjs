// 受控浏览器登录：候选排序、pickCookie、等文件、`waitFor` 的语义。
// 真启动浏览器不在单测里跑 —— 所以 `waitFor` 那一段被抽成 readyToFinish / pollCookies 两个纯函数。
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const { browserCandidates, findBrowser, pollCookies, readyToFinish, selectCookies, waitForFile } = await import(
  "../src/browser-login.mjs"
)

test("Windows 候选：注册表命中优先，Chrome 在 Edge 前，国产浏览器在列", () => {
  const env = {
    LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local",
    APPDATA: "C:\\Users\\x\\AppData\\Roaming",
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
  }
  const lookup = (exe) => (exe === "360ChromeX.exe" ? "C:\\360\\360ChromeX.exe" : "")
  const list = browserCandidates({ platform: "win32", env, lookup })
  const names = list.map((b) => b.name)
  assert.equal(list[0].path, "C:\\360\\360ChromeX.exe", "注册表命中的 360 极速应排最前")
  assert.ok(names.indexOf("Chrome") < names.indexOf("Edge"), "Chrome 在 Edge 之前")
  assert.ok(names.some((n) => n.includes("QQ")), "QQ 浏览器在候选里")
  assert.ok(list.every((b) => b.path), "候选不应有空路径")
})

test("findBrowser 只返回真实存在的候选；找不到返回 null", () => {
  const env = { PROGRAMFILES: "C:\\PF", LOCALAPPDATA: "C:\\L" }
  const chrome = join("C:\\PF", "Google", "Chrome", "Application", "chrome.exe")
  const found = findBrowser({
    platform: "win32",
    env,
    lookup: () => "",
    exists: (p) => p === chrome,
  })
  assert.equal(found.name, "Chrome")
  assert.equal(findBrowser({ platform: "win32", env, lookup: () => "", exists: () => false }), null)
})

test("selectCookies 只取需要的名字，忽略空值，拼成 Cookie header", () => {
  const cookies = [
    { name: "sid", value: "abc" },
    { name: "uid", value: "42" },
    { name: "other", value: "no" },
    { name: "empty", value: "" },
  ]
  assert.deepEqual(selectCookies(cookies, ["sid", "uid", "empty"]), {
    header: "sid=abc; uid=42",
    found: { sid: "abc", uid: "42" },
  })
  assert.deepEqual(selectCookies(null, ["sid"]), { header: "", found: {} })
})

test("waitForFile：文件出现返回 true，超时返回 false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "magpie-browser-"))
  const file = join(dir, "ready")
  const pending = waitForFile(file, 500, 20)
  setTimeout(() => writeFileSync(file, "1"), 50)
  assert.equal(await pending, true)
  assert.equal(await waitForFile(join(dir, "missing"), 30, 10), false)
})

test("readyToFinish：cookie 齐了还不够，waitFor 说可以才算 (不能写成 ||)", async () => {
  const only = { cookieNames: ["CNBSESSION"], header: "CNBSESSION=v", found: { CNBSESSION: "v" } }

  assert.equal(await readyToFinish(only), true, "没给 waitFor 时行为与以前一致")

  let allowed = false
  assert.equal(await readyToFinish({ ...only, waitFor: () => allowed }), false, "waitFor 为假时不许收工")
  allowed = true
  assert.equal(await readyToFinish({ ...only, waitFor: async () => allowed }), true)

  // cookie 不齐时连问都不该问 waitFor
  let asked = 0
  const missing = { cookieNames: ["CNBSESSION"], header: "", found: {} }
  assert.equal(await readyToFinish({ ...missing, waitFor: () => (asked += 1, true) }), false)
  assert.equal(asked, 0, "cookie 没齐就别去问 waitFor")
})

test("pollCookies：cookie 齐但 waitFor 为假时一直在轮询，不会提前返回", async () => {
  let allowed = false
  let reads = 0
  const pending = pollCookies({
    readCookies: async () => {
      reads += 1
      return [{ name: "CNBSESSION", value: "session-value" }]
    },
    cookieNames: ["CNBSESSION"],
    deadline: Date.now() + 5_000,
    stepMs: 10,
    waitFor: () => allowed,
  })

  await new Promise((r) => setTimeout(r, 120))
  assert.ok(reads > 2, `waitFor 为假时应该在继续轮询（实际读了 ${reads} 次）`)
  allowed = true

  const result = await pending
  assert.equal(result.found.CNBSESSION, "session-value")
  assert.equal(result.cookie, "CNBSESSION=session-value")
})

test("pollCookies：waitFor 永远为假 → 到点超时抛，而不是挂死", async () => {
  await assert.rejects(
    pollCookies({
      readCookies: async () => [{ name: "CNBSESSION", value: "v" }],
      cookieNames: ["CNBSESSION"],
      deadline: Date.now() + 120,
      stepMs: 10,
      waitFor: () => false,
    }),
    /登录超时：没有拿到 CNBSESSION/,
  )
})

test("registryAppPath：查不到就返回空串，且不往 stderr 写东西", async () => {
  // 真实事故苗头：`reg query` 查不到项时会把「错误: 系统找不到指定的注册表项或值。」
  // 写到**继承来的** stderr 上 —— 一次 findBrowser() 能刷 20 多行中文噪声进 magpie 日志。
  // 修法是在 execFileSync 里显式给 `stdio: ["ignore", "pipe", "ignore"]`，这条把行为锁住。
  if (process.platform !== "win32") return
  const { registryAppPath } = await import("../src/browser-login.mjs")
  const original = process.stderr.write.bind(process.stderr)
  let noisy = 0
  process.stderr.write = (chunk, ...rest) => {
    noisy += String(chunk).length
    return original(chunk, ...rest)
  }
  try {
    const found = registryAppPath("definitely-not-a-browser-xyz.exe")
    assert.equal(found, "", "查不到就是空串，不要抛、也不要编一个路径")
  } finally {
    process.stderr.write = original
  }
  assert.equal(noisy, 0, `registryAppPath 往 stderr 写了 ${noisy} 个字符（子进程 stderr 没被 ignore）`)
})
