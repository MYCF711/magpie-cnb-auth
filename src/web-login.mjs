// src/web-login.mjs —— 浏览器网页登录：一个窗口里同时收下「额度」和「通道」
//
// 为什么需要第 4 条登录路：CNB 的两套鉴权天然把一件事劈成两半 ——
//
//   api.cnb.cool   只吃访问令牌（PAT）      → 额度、组织、仓库、徽章
//   cnb.cool       只吃网页登录态（CNBSESSION）→ AI 通道（跑模型）
//
// 前三条路（设备码 / 本机 cnb-cli / 粘贴）拿到的都是 PAT：额度有数、模型打不通。
// 这条路的做法是**开一个受控浏览器窗口**（一次性 profile，不碰用户日常浏览器），
// 用户在里面登录 cnb.cool、点一次「确认授权」，插件同时收下两样东西：
//
//   · CNBSESSION   从 CDP 抓 Cookie（src/browser-login.mjs）
//   · 访问令牌     并行走一次 OAuth 设备码（src/device.mjs）
//
// ⚠ 这两件事是**并行**的：窗口开着的时候设备码轮询就在后台跑。所以 `chromiumLogin` 要等
//   「cookie 齐了 **且** token 轮询结束」才收工（`waitFor` 参数）—— 只等 cookie 的话，
//   用户还没点「确认授权」窗口就被关掉，PAT 永远拿不到。
//
// ⚠ 为什么不能直接读用户自己浏览器的 Cookie 库：浏览器在跑的时候库文件被独占锁定，
//   `cp` 与 node:sqlite 都打不开（2026-11-02 实测）。所以只能「开一个自己的窗口」。
//
// ⚠ 这是一个**会等用户**的操作：它只能出现在 `authorize().callback()` 里，绝不能出现在
//   `authorize()` 本身（铁律 2：authorize 必须立刻返回）。见 index.mjs 的装配。

import { OAUTH_CLIENT_ID, WEB_BASE } from "./context.mjs"
import { chromiumLogin, findBrowser } from "./browser-login.mjs"
import { pollDeviceToken, requestDeviceCode } from "./device.mjs"
import { fetchCsrf, fetchTopGroups, fetchUser, listRepos } from "./api.mjs"
import { displayNameOf, pickRepo } from "./credential.mjs"
import { errorText } from "./http.mjs"
import { createGroupWithSession, suggestGroupPath } from "./org.mjs"

/** 要抓的那个 Cookie：CNB 的 AI 端点只认它 */
export const LOGIN_COOKIE = "CNBSESSION"

/** 顺手建组织时给它的说明（会显示在 CNB 的组织页上，所以写人话、别写内部术语） */
export const GROUP_DESCRIPTION = "由 magpie 的 CNB 插件创建"

/** 错误对象 → 一行给人看的话（截断，免得把整个响应体塞进卡片） */
function msg(error) {
  return String(error?.message || error || "未知错误").slice(0, 300)
}

/** 组织 / 仓库路径统一去掉首尾斜杠 */
function cleanPath(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "")
}

/** 抓 csrf —— 抓不到就空串：`src/chat.mjs` 发请求前还会再抓一次，缺了多数请求也能过 */
async function safeCsrf(fetchCsrfFn, session) {
  try {
    const value = await fetchCsrfFn({ session })
    return { csrfToken: String(value?.csrfToken || ""), csrfkey: String(value?.csrfkey || "") }
  } catch {
    return { csrfToken: "", csrfkey: "" }
  }
}

/**
 * 浏览器网页登录：开窗 → 用户登录 + 点「确认授权」→ 同时拿 CNBSESSION 与访问令牌。
 *
 * 四种结局，都要能说清是哪一种（测试锁的就是这个）：
 *
 *   ① 两样都有      → `access` 放 **PAT**（额度要它），`metadata.session` 放 CNBSESSION（跑模型要它）
 *   ② 只有 session  → `access` 放 session，`metadata.kind = "session"`（额度那一行会明说要补 PAT）
 *   ③ 只有 token    → `access` 放 PAT，没有 session（窗口里没抓到网页登录态）
 *   ④ 都没有        → `failed`，并说清「下次怎么点才会成」
 *
 * ⚠ 所有依赖都能从 `ctx` 注入（`findBrowser` / `chromiumLogin` / `requestDeviceCode` /
 *   `pollDeviceToken` / `fetchCsrf` / `fetchUser` / `fetchTopGroups` / `listRepos` /
 *   `createGroup`）。这不是为了「可配置」，是为了这四条分支能离线测 ——
 *   真跑一遍要 GUI 浏览器 + 一个 CNB 账号，跑不进 CI。
 *
 * @param {object} [options] `normaliseOptions()` 之后的那份（读 `org` / `repo` / `repoName`）
 * @param {object} [ctx] 注入点 + `signal` / `timeoutMs` / `platform` / `clientId`
 * @returns {Promise<object>} magpie `authorize().callback()` 要的成功 / 失败形状
 */
export async function loginViaBrowser(options = {}, ctx = {}) {
  const dep = (name, fallback) => (typeof ctx?.[name] === "function" ? ctx[name] : fallback)
  const findBrowserFn = dep("findBrowser", findBrowser)
  const chromiumLoginFn = dep("chromiumLogin", chromiumLogin)
  const requestDeviceCodeFn = dep("requestDeviceCode", requestDeviceCode)
  const pollDeviceTokenFn = dep("pollDeviceToken", pollDeviceToken)
  const fetchCsrfFn = dep("fetchCsrf", fetchCsrf)
  const fetchUserFn = dep("fetchUser", fetchUser)
  const fetchTopGroupsFn = dep("fetchTopGroups", fetchTopGroups)
  const listReposFn = dep("listRepos", listRepos)
  const createGroupFn = dep("createGroup", createGroupWithSession)

  // ① 本机得有一个 Chromium 内核浏览器 —— 没有这条路就不存在，与其开一半失败，不如当场说清
  const browser = findBrowserFn()
  if (!browser) {
    return {
      type: "failed",
      error:
        "没找到 Chromium 内核浏览器（Chrome / Edge / 360 / QQ / Brave 等）。装一个再点这条；" +
        "不想装浏览器的话，用「浏览器授权登录」或直接「粘贴访问令牌」。",
    }
  }

  // ② 先领设备码 —— 必须在开窗之前，因为窗口要直接打开带码的确认页
  let dev
  try {
    dev = await requestDeviceCodeFn({
      platform: ctx.platform || WEB_BASE,
      clientId: ctx.clientId || OAUTH_CLIENT_ID,
      signal: ctx.signal,
    })
  } catch (error) {
    return {
      type: "failed",
      error: `申请设备授权失败：${msg(error)}。可以先用「浏览器授权登录」—— 那条只拿访问令牌，额度能查、模型打不了。`,
    }
  }

  // ③ 设备码轮询**不要 await**：它要和「窗口里等用户登录」并行发生
  //
  // ⚠ `.catch(e => e)` 把失败收成一个普通值。不收的话，用户在窗口里慢慢登录时，
  //   这个 Promise 会先 reject —— 变成一个没人处理的拒绝，而这里想要的只是「这一半没拿到」。
  //
  // ⚠ 关窗 / 取消时要把它掐掉（内建 AbortController）：否则用户把窗口关了，后台还会
  //   继续轮询到设备码过期为止。
  const abort = new AbortController()
  const tokenSignal = ctx.signal ?? abort.signal
  let tokenDone = false
  const tokenP = Promise.resolve()
    .then(() => pollDeviceTokenFn(dev, { signal: tokenSignal }))
    .catch((error) => error)
    .then((value) => {
      tokenDone = true
      return value
    })

  // ④ 开窗等用户：cookie 齐了还不算完，还要等他点完「确认授权」（`waitFor` 就是这件事）
  let captured = null
  let windowError = null
  try {
    captured = await chromiumLoginFn({
      browser,
      url: dev.verificationUriComplete,
      cookieNames: [LOGIN_COOKIE],
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      waitFor: () => tokenDone,
    })
  } catch (error) {
    // 用户关窗 / 超时 / 取消 —— 不算致命：token 那一半可能已经拿到了（见下面「只有 token」）
    windowError = error
  } finally {
    // 窗口都没了，轮询再跑也没有意义（成功时它早就 settle 了，这次 abort 是空操作）
    abort.abort()
  }

  const session = String(captured?.found?.[LOGIN_COOKIE] || "")
  const token = await tokenP
  const tokenOk = Boolean(token && !(token instanceof Error) && token.access_token)
  const access = tokenOk ? String(token.access_token) : ""

  // ⑤ 两样都没有 —— 说清「下次怎么点才会成」，别说「登录失败请重试」
  if (!session && !access) {
    return {
      type: "failed",
      error:
        `窗口关了但没拿到登录态（${LOGIN_COOKIE}）与访问令牌：${windowError ? msg(windowError) : "窗口里没有完成登录"}。` +
        "再点一次：先在窗口里**登录 cnb.cool**，再点页面上的「确认授权」，然后别关窗口，等它自己收工。",
    }
  }

  const csrf = session ? await safeCsrf(fetchCsrfFn, session) : { csrfToken: "", csrfkey: "" }

  // ⑥ 只有网页登录态（token 那一半失败或超时）：模型能跑，额度查不了
  if (!access) {
    const org = cleanPath(options.org)
    const repo = pickRepo([], "", { ...options, org })
    return {
      type: "success",
      // ⚠ 纯 session 只能放 `access`（magpie 一定得有个凭据）。`metadata.kind` 必须标成
      //   session：src/credential.mjs 的 resolveAccount 靠它分账 —— 判成 PAT 就会拿它去查
      //   额度，那是必然 401，而且模型通道会是空的（两种都只坏一半，很难查）。
      access: session,
      accountId: "",
      uid: "",
      org,
      repo,
      metadata: {
        kind: "session",
        session,
        csrfkey: csrf.csrfkey,
        org,
        repo,
        loginMethod: "browser",
        browser: browser.name,
        // 这一半为什么缺：token 那一侧的错因留着，排查时不用猜（额度那一行会照实说要补 PAT）
        tokenError: token instanceof Error ? msg(token) : "",
      },
    }
  }

  // ⑦ 有访问令牌：补齐账号信息 / 组织 / 仓库（与设备码登录同一套探测）
  let user = null
  try {
    user = await fetchUserFn(access)
  } catch {
    user = null
  }
  const name = displayNameOf(user)
  let groups = await fetchTopGroupsFn(access)
  let org = cleanPath(options.org) || cleanPath(groups[0]?.path)
  let repos = org ? await listReposFn(access, org) : []

  // ⑧ 没有组织就**顺手建一个** —— 这是这条登录路存在的另一半理由
  //
  // ⚠ 为什么只有这里能建：建组织要的是网页登录态（PAT 申请不到 `group-manage:rw`，
  //   实测 invalid_scope）。而「顺手建」只发生在**用户亲手点了这条登录方式**的时候；
  //   usage / loader / models 这些读钩子里绝不会自动建（读钩子不该有副作用）。
  // ⚠ 建失败**不算登录失败**：把 status 记进 `metadata.orgAttempt`，卡片按它说话
  //   （src/org.mjs 的 orgHint）。也**不重试** —— 403 再试一百次还是 403。
  let orgAttempt = null
  if (!org && session) {
    const suggested = suggestGroupPath(name || user?.username || "", { taken: groups.map((g) => g.path) })
    const created = await createGroupFn({
      session,
      csrfToken: csrf.csrfToken,
      csrfkey: csrf.csrfkey,
      path: suggested,
      description: GROUP_DESCRIPTION,
      signal: ctx.signal,
      fetch: ctx.fetch,
    })
    orgAttempt = {
      ok: Boolean(created?.ok),
      status: Number(created?.status) || 0,
      path: suggested,
      ...(created?.ok ? {} : { message: errorText(created?.body || {}).slice(0, 200) }),
    }
    if (created?.ok) {
      // 建完重新探一次：以服务端为准（它可能改了 slug），别把我们的猜测写进账号
      groups = await fetchTopGroupsFn(access)
      org = cleanPath(options.org) || cleanPath(groups[0]?.path) || suggested
      repos = org ? await listReposFn(access, org) : []
    }
  }

  // 仓库路径每次都重算（显式选项 > 探测到的列表 > 猜 `<org>/<repoName>`）——
  // 与设备码登录、src/credential.mjs 的 pickRepo 用同一套优先级
  const repo = pickRepo(repos, "", { ...options, org })

  return {
    type: "success",
    // ⚠ 分账只有一种正确写法：**PAT 放 `access`**（额度必须用它查），
    //   **CNBSESSION 放 `metadata.session`**（跑模型用它）。反过来的话，要么额度 401、
    //   要么模型通道是空的 —— 而且两种都只坏一半，用户只会觉得「插件有时候好使」。
    access,
    refresh: String(token.refresh_token || ""),
    expires: Date.now() + (Number(token.expires_in) || 28_800) * 1000,
    // ⚠ 名字取昵称：新账号的 `username` 是 `cnb.dI2DzHg0QHA` 这种系统编的串（AGENTS 坑 27）
    accountId: name,
    uid: String(user?.id || user?.username || ""),
    org,
    repo,
    metadata: {
      kind: "pat",
      session,
      csrfkey: csrf.csrfkey,
      org,
      repo,
      username: user?.username || "",
      nickname: name,
      userId: String(user?.id || ""),
      clientId: dev.clientId,
      groups: groups.map((g) => g.path),
      loginMethod: "browser",
      browser: browser.name,
      ...(orgAttempt ? { orgAttempt } : {}),
    },
  }
}
