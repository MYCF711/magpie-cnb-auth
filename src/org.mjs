// src/org.mjs —— 组织（CNB 里叫 group）：造一个合法 slug，再用网页登录态试着建一个
//
// 为什么需要它：CNB 的 AI Credit 按**组织**发放，AI 端点也挂在 `/{org}/{repo}/-/ai/...` 下。
// 实测（2026-11-02，当天注册的账号）：`GET /user/groups` 就是 `[]` —— 这种账号既没有额度可读、
// 也没有通道可用。而**设备码登录拿到的 PAT 建不了组织**：
//
//   `POST https://api.cnb.cool/groups` 在 OpenAPI 里存在（201），但 `cnb_cli` 这个 OAuth
//   客户端申请不到 `group-manage:rw`（实测 `invalid_scope`）。
//
// 所以能建组织的唯一凭据是**网页登录态**（CNBSESSION + csrf），也就是「浏览器网页登录」
// 那条路才拿得到的东西。见 src/web-login.mjs。
//
// ⚠ **建组织这条没在真机上验证过。** 本机没有可用的 CNBSESSION（Edge 在跑 → Cookie 库被
//   独占锁定，`cp` 与 node:sqlite 都打不开），所以只验到了「请求形状」：路径、头、body 与
//   `https://api.cnb.cool/swagger.json` 里的 `POST /groups`（需要 `group-manage:rw`）对齐。
//   **cookie 鉴权能不能过未知** —— 它可能同样只吃 Bearer，也可能要额外的 csrf 头。
//
//   因此这个函数：① 返回值只有 `{ ok, status, body }`，**绝不抛**；② 调用方按 status 说话
//   （403 = 没权限，400/409 = 名字不合法或已存在），不要假设成功，也不要自动重试。
//
// ⚠ 建组织是**对外可见**的动作（会出现在用户的 CNB 账号下、别人也能看到那个 slug）。
//   所以只允许在「用户亲手点了浏览器网页登录」这一条路里试一次；
//   usage / loader / models / refresh 这些读钩子一律不许调它 —— 读钩子不该有副作用。

import { API_BASE, WEB_BASE } from "./context.mjs"
import { abortSignal, baseHeaders, readBody } from "./http.mjs"

/** 建组织走 OpenAPI：`POST https://api.cnb.cool/groups`（字段形状来自 swagger.json） */
export const GROUP_API = `${API_BASE}/groups`

/** CNB 组织 slug 的长度区间（2~30） */
export const GROUP_SLUG_MIN = 2
export const GROUP_SLUG_MAX = 30

/** 一个字符都留不下时的兜底（中文昵称很常见，不能因此报错） */
const FALLBACK_SLUG = "cnb-user"

/** 名字 → 只含 `a-z0-9-` 的小写串（可能为空串） */
function slugify(value) {
  return String(value ?? "")
    .trim()
    // `cnb.` 是 CNB 给新账号自动生成用户名时的前缀（`cnb.dI2DzHg0QHA`），是系统标记不是名字
    .replace(/^cnb\./i, "")
    .toLowerCase()
    // 非 `[a-z0-9]` 一律压成**一个** `-`：连续的点、空格、下划线、中文都只会留下一个分隔符
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** 长度落到 2~30：太长截断并掐掉尾巴上的 `-`；太短（<2）返回空串，交给调用方兜底 */
function clampSlug(slug) {
  const s = String(slug || "").slice(0, GROUP_SLUG_MAX).replace(/-+$/g, "")
  return s.length >= GROUP_SLUG_MIN ? s : ""
}

/** 在 base 后面接一段后缀；超长就从 base 的尾巴上让位。结果不合法时返回空串 */
function withSuffix(base, suffix) {
  const room = Math.max(GROUP_SLUG_MIN, GROUP_SLUG_MAX - String(suffix).length)
  const head = base.length > room ? base.slice(0, room).replace(/-+$/g, "") : base
  return clampSlug(`${head}${suffix}`)
}

/**
 * 把「名字」压成一个合法的组织 slug。
 *
 * 为什么要它：CNB 给新账号自动生成的用户名长这样 —— `cnb.dI2DzHg0QHA`（实测 2026-11-02），
 * 带点号、大小写混排，直接当组织名会被拒；而昵称更常见的是中文，一个字符都留不下。
 *
 * 规则（全部小写字母数字与 `-`，长度 2~30）：
 *   ① 去掉 `cnb.` 前缀 —— 那是「系统编的」标记，不是名字；
 *   ② 非 `[a-z0-9]` 压成单个 `-`（所以 `a---b`、`a  b` 都只会剩一个分隔符）；
 *   ③ 掐掉首尾的 `-`；
 *   ④ 太长截断到 30，太短（<2，比如纯中文）用固定兜底 `cnb-user`；
 *   ⑤ 与 `taken` 里的名字撞了就加 `-code`，再撞加 `-code-2`、`-code-3`…（上限 9 次）。
 *
 * ⚠ 它只保证「合法」，不保证「没被别人占」：唯一知道的冲突来自调用方传进来的 `taken`，
 *   真正的占用要等 `POST /groups` 回的 status。
 *
 * @param {string} source 昵称 / 用户名（取不到就给空串）
 * @param {{taken?:string[], suffix?:string}} [o]
 * @returns {string} 合法的组织 slug
 */
export function suggestGroupPath(source, { taken = [], suffix = "-code" } = {}) {
  const base = clampSlug(slugify(source)) || FALLBACK_SLUG
  const used = new Set((Array.isArray(taken) ? taken : []).map((t) => String(t || "").trim().toLowerCase()))
  if (!used.has(base)) return base

  const first = withSuffix(base, suffix)
  if (first && !used.has(first)) return first
  for (let n = 2; n <= 9; n += 1) {
    const next = withSuffix(base, `${suffix}-${n}`)
    if (next && !used.has(next)) return next
  }
  // 撞了 9 次也只好交第一候选，让上游去拒 —— 这里不编更长的一串去试探
  return first || base
}

/**
 * 用网页登录态建一个组织。
 *
 * ⚠ **没在真机上验证过**（原因见文件头）：请求形状来自 swagger.json 的 `POST /groups`，
 *   但**这个端点认不认 Cookie 未知**。所以这里只如实把「请求发出去、上游怎么答」交回去，
 *   不替上游解释、不重试、也不抛。
 *
 * ⚠ `Csrftoken` 用页面里的 csrftoken，抓不到就退回 csrfkey（CNB 网页侧两者是同一套校验，
 *   见 src/api.mjs 的 `cnbWeb()`）。
 *
 * @param {object} o
 * @param {string} o.session        CNBSESSION（网页登录态）
 * @param {string} [o.csrfToken]    页面里的 `window.csrftoken`
 * @param {string} [o.csrfkey]      Cookie 里的 csrfkey
 * @param {string} o.path           组织 slug（用 suggestGroupPath 生成）
 * @param {string} [o.description]  组织说明
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.timeoutMs]
 * @param {Function} [o.fetch]      注入用（单测喂假 fetch 的地方）
 * @returns {Promise<{ok:boolean, status:number, body:object}>} **绝不抛**
 */
export async function createGroupWithSession({
  session,
  csrfToken = "",
  csrfkey = "",
  path,
  description = "",
  signal,
  timeoutMs = 15_000,
  fetch: fetchImpl = fetch,
} = {}) {
  const slug = String(path || "").trim()
  if (!session) {
    return { ok: false, status: 0, body: { errmsg: "没有 CNBSESSION，建不了组织（这个端点只吃网页登录态）" } }
  }
  if (!slug) return { ok: false, status: 0, body: { errmsg: "没有给出组织 slug" } }

  const cookies = [`CNBSESSION=${session}`]
  if (csrfkey) cookies.push(`csrfkey=${csrfkey}`)
  const csrf = String(csrfToken || csrfkey || "")

  let response
  try {
    response = await fetchImpl(GROUP_API, {
      method: "POST",
      headers: baseHeaders({
        cookie: cookies.join("; "),
        origin: WEB_BASE,
        referer: `${WEB_BASE}/`,
        "content-type": "application/json",
        ...(csrf ? { csrftoken: csrf } : {}),
      }),
      body: JSON.stringify({ path: slug, description: String(description ?? "") }),
      signal: abortSignal(signal, timeoutMs),
    })
  } catch (error) {
    // 网络断了 / 超时 / 被 abort：一律当「没建成」，原因塞进 body，形状保持不变
    return { ok: false, status: 0, body: { errmsg: `连不上 api.cnb.cool：${error?.message || error}` } }
  }

  return { ok: Boolean(response.ok), status: Number(response.status) || 0, body: await readBody(response) }
}

/**
 * 卡片上那句「还没有组织」。
 *
 * ⚠ 读钩子不许建组织，所以 `usage()` 只能**指路**：`fetchUsageSnapshot()` 只会回
 *   「还没有组织」或「额度需要访问令牌」，而这两件事都能被「浏览器网页登录」一次解决
 *   （它同时收 CNBSESSION 与 PAT，没组织还会顺手建一个）。
 *
 * ⚠ 已经试过建、且失败了，就按上游的 status 说清为什么：否则用户会照着「再点一次登录」
 *   反复点，而它永远不会成功。
 *
 * @param {{noOrg?:boolean, session?:string, token?:string}} account `resolveAccount()` 的返回值
 * @param {object} auth magpie 传进钩子的账号对象（读 `metadata.orgAttempt`）
 * @returns {string} 适用时返回整句提示，不适用返回空串
 */
export function orgHint(account, auth) {
  if (!account?.noOrg || !account?.session) return ""
  const entry = "https://cnb.cool/new/groups"
  // 只有网页登录态的账号，组织建得再好也查不了额度：api.cnb.cool 不吃 cookie
  const tokenPart = account.token
    ? ""
    : "另外这条账号只有网页登录态，没有访问令牌 —— 额度那一行仍然读不出来：重登一次「浏览器网页登录」并把窗口里的「确认授权」点完，或到 https://cnb.cool/profile/token 生成一个粘进来。"

  const attempt = auth?.metadata?.orgAttempt
  if (attempt && attempt.ok === false) {
    const status = Number(attempt.status) || 0
    const why = status ? `HTTP ${status}` : "请求没发出去"
    return (
      `这个 CNB 账号还没有组织，上次「浏览器网页登录」顺手建组织没成（${why}${attempt.message ? `：${attempt.message}` : ""}）。` +
      `到 ${entry} 手动建一个（或在插件选项里填 org），再回来刷新这张卡。` +
      tokenPart
    )
  }

  return (
    "这个 CNB 账号还没有组织 —— AI Credit 是按组织发放的，AI 端点也挂在 /{org}/{repo} 下。" +
    `点「浏览器网页登录」可以顺带建组织（一次拿到额度 + 通道）；也可以直接到 ${entry} 建一个。` +
    tokenPart
  )
}
