// tests/mount.test.mjs —— 入口 / 九钩子挂载契约
//
// 锁的是「index.mjs 有没有被改坏」：导出形状、九项钩子齐不齐、config 有没有模型、
// loader 给不给得出来、models 会不会按通道把 toolcall 标对。
//
// 全部离线；不需要 magpie 进程、不需要凭据。
// 跑法：node --test tests/mount.test.mjs

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import * as entry from "../index.mjs"
import { _internal, CnbAuthPlugin } from "../index.mjs"
import { usage, usageWindow } from "../src/quota.mjs"

/** 一个形状合法的 CNBSESSION（三段：数字.数字.<长 hex>），不会打任何网络请求 */
const SESSION = "123456.789012.0123456789abcdef0123456789abcdef"

test("入口只导出一个函数（插件工厂）", () => {
  const functions = Object.entries(entry)
    .filter(([, value]) => typeof value === "function")
    .map(([key]) => key)
  assert.deepEqual(functions, ["CnbAuthPlugin"])
})

test("_internal 是对象，helper 不暴露成顶层函数导出", () => {
  assert.equal(typeof _internal, "object")
  assert.equal(_internal.PROVIDER, "cnb")
  assert.equal(typeof _internal.staticModels, "function")
  assert.ok(Array.isArray(_internal.MODEL_SPECS) && _internal.MODEL_SPECS.length > 0)
})

test("九项钩子齐全", async () => {
  const plugin = await CnbAuthPlugin({ client: {}, directory: undefined })
  assert.equal(typeof plugin.config, "function")
  assert.ok(plugin.auth && typeof plugin.auth === "object")
  assert.equal(plugin.auth.provider, _internal.PROVIDER)
  assert.equal(typeof plugin.auth.refresh, "function")
  assert.equal(typeof plugin.auth.loader, "function")
  assert.equal(typeof plugin.auth.usage, "function")
  assert.equal(typeof plugin.auth.checkin, "function")
  assert.equal(typeof plugin.provider.models, "function")
  assert.equal(typeof plugin["chat.headers"], "function")
  assert.equal(plugin.provider.id, _internal.PROVIDER)
  assert.ok(plugin.auth.icon?.startsWith("data:image/"), "图标必须内嵌（外部 URL 在 git 源下不渲染）")
  assert.ok(Number.isInteger(plugin.auth.maxConcurrency) && plugin.auth.maxConcurrency >= 1)
})

test("config() 未登录也声明了模型，且 modalities / 五个 input 布尔都在", async () => {
  const plugin = await CnbAuthPlugin({ client: {} })
  const cfg = {}
  await plugin.config(cfg)
  const provider = cfg.provider?.[_internal.PROVIDER]
  assert.ok(provider, "必须声明 provider")
  assert.equal(provider.npm, "@ai-sdk/openai-compatible")
  const models = provider.models
  assert.ok(models && Object.keys(models).length > 0, "config.models 不能为空（铁律 1）")

  for (const [id, model] of Object.entries(models)) {
    // config 路径读的是 modalities，不是 capabilities；只写后者等于没写。
    assert.ok(Array.isArray(model.modalities.input), `${id}.modalities.input 必须给`)
    assert.deepEqual(model.modalities.output, ["text"], `${id}.modalities.output 必须给`)
    // HOOKS 十一之三：五个模态键必须显式写布尔（省略 image ≠ text）
    for (const key of ["text", "image", "audio", "video", "pdf"]) {
      assert.equal(typeof model.capabilities.input[key], "boolean", `${id}.capabilities.input.${key} 必须是布尔`)
    }
    assert.equal(typeof model.capabilities.output.text, "boolean")
    assert.equal(typeof model.limit.context, "number", `${id} 必须有实测上下文`)
  }

  // 只有 vision 那条能收图 —— 反向断言，防「全都标成能收图」
  assert.deepEqual(models["glm-5.3-flash-vision"].modalities.input, ["text", "image"])
  assert.deepEqual(models["deepseek-v4.1-flash"].modalities.input, ["text"])
  assert.equal(models["deepseek-v4.1-flash"].capabilities.input.image, false)
})

test("四条登录方式：设备码 / 本机 / 受控浏览器 / 粘贴，且 authorize 都是 async", async () => {
  const plugin = await CnbAuthPlugin({ client: {} })
  const methods = plugin.auth.methods
  assert.equal(methods.length, 4, "四条路：设备码（可加账号）、本机 cnb-cli、受控浏览器（额度+通道）、粘贴凭证")

  const [device, local, browser, paste] = methods
  assert.equal(device.type, "oauth")
  assert.equal(typeof device.authorize, "function")
  assert.equal(device.authorize.constructor.name, "AsyncFunction")

  assert.equal(local.type, "oauth")
  assert.equal(typeof local.authorize, "function")

  // 受控浏览器那条：窗口由插件自己开，所以必须是 opened: true（HOOKS 陷阱 3），
  // 而且 authorize() 只能立刻返回 —— 开窗与等用户都在 callback 里。
  assert.equal(browser.type, "oauth")
  assert.equal(typeof browser.authorize, "function")
  const start = await browser.authorize()
  assert.equal(start.opened, true, "窗口由插件自己开，别再让宿主开一个")
  assert.equal(start.method, "auto")
  assert.equal(typeof start.callback, "function")
  assert.match(String(start.url), /^https:\/\/cnb\.cool\//, "url 必须是 CNB 的登录/确认入口")

  // ⚠ 粘贴方式绝对不能带 authorize：magpie 只把 prompts 的答案传进去，
  //   输入框里的值拿不到，加了只会读到 undefined。
  assert.equal(paste.type, "api")
  assert.equal(paste.authorize, undefined, "api 方式不许有 authorize（否则用户粘的值进不来）")
  assert.equal(paste.prompts, undefined)
  assert.equal(typeof paste.placeholder, "string")
})

test("loader()：未登录返回空对象；有 CNBSESSION 时给 cookie 通道", async () => {
  const plugin = await CnbAuthPlugin({ client: {} })

  const empty = await plugin.auth.loader(async () => null, { id: _internal.PROVIDER })
  assert.deepEqual(empty, {})

  const cookie = await plugin.auth.loader(async () => ({ type: "api", key: SESSION }), { id: _internal.PROVIDER })
  assert.equal(typeof cookie.fetch, "function")
  assert.equal(typeof cookie.baseURL, "string")
  assert.match(cookie.baseURL, /\/-\/ai$/, "CNB 的 AI 入口挂在 /{org}/{repo}/-/ai 下")
})

test("provider.models：cookie 通道把 toolcall 标成 false，relay 通道标成 true", async () => {
  const plugin = await CnbAuthPlugin({ client: {} })

  const cookie = await plugin.provider.models(
    {},
    { auth: { type: "api", key: SESSION } },
  )
  for (const [id, model] of Object.entries(cookie)) {
    assert.equal(model.capabilities.toolcall, false, `${id}: cookie 通道不支持 tools，标 true 就是假声明`)
    assert.equal(model.tool_call, false, `${id}: config 路径的那个拼写也要纠正`)
    assert.equal(model.api.npm, "@ai-sdk/openai-compatible")
  }

  const anonymous = await plugin.provider.models({}, { auth: null })
  assert.ok(Object.keys(anonymous).length > 0, "未登录也要有模型表")

  // 配了 relay 就走 relay，能力恢复

  const relayPlugin = await CnbAuthPlugin({ client: {} }, { transport: "relay", relay: { url: "https://relay.example/v1", key: "k" } })
  const relay = await relayPlugin.provider.models({}, { auth: { type: "api", key: SESSION } })
  assert.equal(relay["deepseek-v4.1-flash"].capabilities.toolcall, true)
})

test("usage 构造器可用：至少造一条参与路由的窗口", () => {
  const value = usage({
    plan: "Test",
    windows: [usageWindow({ name: "AI Credit（当月）", amount: 37, limit: 500, unit: "credits" })],
  })
  assert.equal(typeof value.plan, "string")
  assert.equal(value.windows.length, 1)
  assert.equal(Number.isFinite(value.windows[0].used), true)
})

test("usage() 未登录时给出 error 而不是伪造 0", async () => {
  const plugin = await CnbAuthPlugin({ client: {} })
  const anonymous = await plugin.auth.usage(async () => null, { id: _internal.PROVIDER })
  assert.match(String(anonymous.error), /未登录/)
  assert.deepEqual(anonymous.windows, [])
})

test("usage()：没有组织 + 只有网页登录态 → 指路「浏览器网页登录」，且读钩子里绝不建组织", async () => {
  const plugin = await CnbAuthPlugin({ client: {} })
  const result = await plugin.auth.usage(async () => ({ type: "api", key: SESSION }), { id: _internal.PROVIDER })

  assert.match(String(result.error), /还没有组织/)
  assert.match(String(result.error), /浏览器网页登录/)
  assert.match(String(result.error), /顺带建组织/, "提示要指向那条真的能建组织的登录路")
  assert.match(String(result.error), /访问令牌/, "只有 session 的账号还要说清额度差一个 PAT")
  assert.deepEqual(result.windows, [])
})

test("checkin()：没配 claim.url 就是 inactive（CNB 没有每日签到）", async () => {
  const plugin = await CnbAuthPlugin({ client: {} })
  const result = await plugin.auth.checkin(async () => ({ type: "api", key: SESSION }), { id: _internal.PROVIDER })
  assert.equal(result.outcome, "inactive")
  assert.match(result.message, /每月/)
})

test("chat.headers 只给本 provider 的请求加头", async () => {
  const plugin = await CnbAuthPlugin({ client: {} })
  const mine = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: _internal.PROVIDER } }, mine)
  assert.equal(typeof mine.headers["x-cnb-client"], "string")

  const other = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: "other" } }, other)
  assert.deepEqual(other.headers, {})
})

test("auth.refresh 走 refresh lock，而不是裸调续期", () => {
  // 模块行为由 tests/refresh-lock.test.mjs 锁，这里只防止未来重构把闸拆掉。
  const source = readFileSync(new URL("../index.mjs", import.meta.url), "utf8")
  assert.match(source, /import \{ createRefreshLock \} from "\.\/src\/refresh-lock\.mjs"/)
  assert.match(source, /refreshLock\.run\(/)
})
