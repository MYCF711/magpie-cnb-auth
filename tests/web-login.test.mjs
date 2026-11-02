// tests/web-login.test.mjs —— 第 4 条登录路的四种结局，全离线
//
// 真跑一遍要 GUI 浏览器 + 一个 CNB 账号 + 一次真的「确认授权」，跑不进 CI。
// 所以这里把所有外部依赖都从 ctx 注入：
//   浏览器（findBrowser / chromiumLogin）、OAuth（requestDeviceCode / pollDeviceToken）、
//   csrf 与账号信息（fetchCsrf / fetchUser / fetchTopGroups / listRepos）、建组织（createGroup）。
//
// 锁的就是「两样凭据怎么分账」这一件事：
//   都有 → access=PAT、metadata.session=CNBSESSION
//   只有 session → access=session、metadata.kind="session"
//   只有 token → access=PAT、没有 session
//   都没有 → failed，且说清楚下次怎么点

import test from "node:test"
import assert from "node:assert/strict"

import { readyToFinish } from "../src/browser-login.mjs"
import { loginViaBrowser } from "../src/web-login.mjs"

/** 形状合法的 CNBSESSION（三段：数字.数字.<长 hex>），不会打任何网络请求 */
const SESSION = "123456.789012.0123456789abcdef0123456789abcdef"
/** 形状合法的访问令牌 */
const PAT = "cnb_at_" + "a".repeat(40)

const DEVICE = {
  platform: "https://cnb.cool",
  clientId: "cnb_cli",
  deviceCode: "device-code",
  userCode: "ABCD-EFGH",
  verificationUri: "https://cnb.cool/oauth2/device/verify",
  verificationUriComplete: "https://cnb.cool/oauth2/device/verify?user_code=ABCD-EFGH",
  expiresIn: 600,
  interval: 5,
}

const BROWSER = { name: "Edge", path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" }

/** 假窗口：真的按 `waitFor` 的语义决定什么时候返回（cookie 齐了也要等另一件事） */
function fakeChromium({ found = {} } = {}) {
  const calls = []
  const fn = async (o) => {
    calls.push(o)
    // 10 轮 × 2ms 足够让「并行的那一半」先 settle（真实实现在这里等 1 秒一轮）
    for (let i = 0; i < 10; i += 1) {
      const header = Object.entries(found)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ")
      if (await readyToFinish({ cookieNames: o.cookieNames, header, found, waitFor: o.waitFor })) {
        return { cookie: header, found, browser: "Edge" }
      }
      await new Promise((r) => setTimeout(r, 2))
    }
    throw new Error("登录超时：没有拿到 CNBSESSION")
  }
  fn.calls = calls
  return fn
}

/** 一份全是假实现的 ctx；每个用例只覆盖自己关心的那几个 */
function makeCtx(overrides = {}) {
  const calls = { createGroup: [], fetchTopGroups: 0, fetchCsrf: 0 }
  const ctx = {
    findBrowser: () => BROWSER,
    requestDeviceCode: async () => DEVICE,
    pollDeviceToken: async () => ({ access_token: PAT, refresh_token: "cnb_rt_refresh", expires_in: 28_800 }),
    fetchCsrf: async () => {
      calls.fetchCsrf += 1
      return { csrfToken: "csrf-token", csrfkey: "csrf-key", htmlLength: 1 }
    },
    fetchUser: async () => ({ id: 42, username: "cnb.dI2DzHg0QHA", nickname: "Tlaloc" }),
    fetchTopGroups: async () => [],
    listRepos: async (_token, org) => [`${org}/code`],
    createGroup: async (args) => {
      calls.createGroup.push(args)
      return { ok: true, status: 201, body: {} }
    },
    ...overrides,
  }
  ctx._calls = calls
  return ctx
}

test("都有：PAT 放 access（查额度），CNBSESSION 放 metadata.session（跑模型）", async () => {
  let probe = 0
  const ctx = makeCtx({
    chromiumLogin: fakeChromium({ found: { CNBSESSION: SESSION } }),
    // 第一次探：没有组织；建完之后再探：有
    fetchTopGroups: async () => {
      probe += 1
      return probe === 1 ? [] : [{ path: "tlaloc" }]
    },
  })

  const result = await loginViaBrowser({}, ctx)

  assert.equal(result.type, "success")
  assert.equal(result.access, PAT, "access 必须是 PAT —— 额度只能用它查")
  assert.equal(result.metadata.kind, "pat")
  assert.equal(result.metadata.session, SESSION, "CNBSESSION 必须进 metadata.session —— 模型只能用它跑")
  assert.equal(result.metadata.csrfkey, "csrf-key")
  assert.equal(result.metadata.loginMethod, "browser")
  assert.equal(result.metadata.browser, "Edge")
  assert.equal(typeof result.expires, "number")
  assert.ok(result.expires > Date.now(), "expires 必须是未来的时间戳")
  assert.equal(result.refresh, "cnb_rt_refresh")
  assert.equal(result.accountId, "Tlaloc", "账号名取昵称，不是 cnb.xxx")
  assert.equal(result.uid, "42")

  // 没组织 → 顺手建一个，slug 从昵称来
  assert.equal(ctx._calls.createGroup.length, 1, "没有组织时应当试着建一次")
  const created = ctx._calls.createGroup[0]
  assert.equal(created.path, "tlaloc")
  assert.equal(created.session, SESSION)
  assert.equal(created.csrfkey, "csrf-key")
  assert.equal(created.csrfToken, "csrf-token")
  assert.deepEqual(result.metadata.orgAttempt, { ok: true, status: 201, path: "tlaloc" })
  // 建完重新探组织：以服务端为准
  assert.equal(result.org, "tlaloc")
  assert.equal(result.repo, "tlaloc/code")
})

test("都有且已有组织：不碰建组织（对外可见的动作只在真需要时做）", async () => {
  const ctx = makeCtx({
    chromiumLogin: fakeChromium({ found: { CNBSESSION: SESSION } }),
    fetchTopGroups: async () => [{ path: "acme" }],
    listRepos: async () => ["acme/site"],
  })

  const result = await loginViaBrowser({}, ctx)

  assert.equal(result.type, "success")
  assert.equal(result.org, "acme")
  assert.equal(result.repo, "acme/site")
  assert.equal(ctx._calls.createGroup.length, 0, "已经有组织就不该建")
  assert.equal(result.metadata.orgAttempt, undefined)
})

test("建组织失败（403）不影响登录，但 status 要留下来说实话", async () => {
  const ctx = makeCtx({
    chromiumLogin: fakeChromium({ found: { CNBSESSION: SESSION } }),
    createGroup: async () => ({ ok: false, status: 403, body: { errcode: 403, errmsg: "User has no permission." } }),
  })

  const result = await loginViaBrowser({}, ctx)

  assert.equal(result.type, "success", "建组织失败不能把整次登录判失败")
  assert.equal(result.access, PAT)
  assert.equal(result.metadata.session, SESSION)
  assert.equal(result.org, "")
  assert.equal(result.metadata.orgAttempt.ok, false)
  assert.equal(result.metadata.orgAttempt.status, 403)
  assert.match(String(result.metadata.orgAttempt.message), /no permission/i)
})

test("只有 session：access 放 session，metadata.kind 标成 session（别让它去查额度）", async () => {
  const ctx = makeCtx({
    pollDeviceToken: async () => {
      throw new Error("等待授权超时，重新点一次登录即可")
    },
    chromiumLogin: fakeChromium({ found: { CNBSESSION: SESSION } }),
  })

  const result = await loginViaBrowser({ org: "acme" }, ctx)

  assert.equal(result.type, "success")
  assert.equal(result.access, SESSION, "只有网页登录态时，凭据就是那条 session")
  assert.equal(result.metadata.kind, "session")
  assert.equal(result.metadata.session, SESSION)
  assert.equal(result.metadata.csrfkey, "csrf-key")
  assert.equal(result.refresh, undefined, "没有 token 就没有 refresh_token")
  assert.match(String(result.metadata.tokenError), /等待授权超时/, "token 那一半的错因要留着")
  assert.equal(result.org, "acme")
  assert.equal(ctx._calls.createGroup.length, 0, "没有 token 就不知道有没有组织，也就不建")
})

test("只有 token：access 放 PAT，但明确没有 session", async () => {
  const ctx = makeCtx({
    // 窗口里没抓到 CNBSESSION → chromiumLogin 超时抛错
    chromiumLogin: fakeChromium({ found: {} }),
    fetchTopGroups: async () => [{ path: "acme" }],
    listRepos: async () => ["acme/site"],
  })

  const result = await loginViaBrowser({}, ctx)

  assert.equal(result.type, "success")
  assert.equal(result.access, PAT)
  assert.equal(result.metadata.kind, "pat")
  assert.equal(result.metadata.session, "")
  assert.equal(result.org, "acme")
  assert.equal(ctx._calls.createGroup.length, 0, "没有 session 就建不了组织")
})

test("都没有：failed，并说清「下次怎么点才会成」", async () => {
  const ctx = makeCtx({
    pollDeviceToken: async () => {
      throw new Error("等待授权超时，重新点一次登录即可")
    },
    chromiumLogin: fakeChromium({ found: {} }),
  })

  const result = await loginViaBrowser({}, ctx)

  assert.equal(result.type, "failed")
  assert.match(result.error, /窗口关了但没拿到登录态/)
  assert.match(result.error, /确认授权/)
  assert.equal(ctx._calls.fetchCsrf, 0, "没凭据就不该再去抓 csrf")
})

test("找不到 Chromium 内核浏览器：failed，且说清装什么", async () => {
  const ctx = makeCtx({ findBrowser: () => null })
  const result = await loginViaBrowser({}, ctx)

  assert.equal(result.type, "failed")
  assert.match(result.error, /没找到 Chromium 内核浏览器/)
  assert.match(result.error, /Chrome/)
  assert.match(result.error, /Edge/)
})

test("新建的组织里没有仓库时，顺手建一个默认仓库（否则 AI 端点还是没有路径）", async () => {
  let probe = 0
  let listed = 0
  const made = []
  const ctx = makeCtx({
    chromiumLogin: fakeChromium({ found: { CNBSESSION: SESSION } }),
    fetchTopGroups: async () => {
      probe += 1
      return probe === 1 ? [] : [{ path: "tlaloc" }]
    },
    // 第一次列：空（刚建出来的组织）；建完仓库再列：有了
    listRepos: async (_t, org) => {
      listed += 1
      return listed === 1 ? [] : [`${org}/code`]
    },
    createRepo: async (token, org, name) => {
      made.push({ token, org, name })
      return { ok: true, status: 201, body: {} }
    },
  })

  const result = await loginViaBrowser({}, ctx)

  assert.equal(made.length, 1, "空组织应当建一个仓库 —— 不建的话「帮你建组织」只做了一半")
  assert.equal(made[0].org, "tlaloc")
  assert.equal(made[0].name, "code", "默认仓库名取 repoName，缺省是 code")
  assert.equal(result.metadata.orgAttempt.repo.ok, true)
  assert.equal(result.repo, "tlaloc/code", "建完仓库后仓库路径要跟着更新")
})

test("组织是用户自己的老组织（没有仓库）时不擅自建仓 —— 只在刚建出来的组织上建", async () => {
  const made = []
  const ctx = makeCtx({
    chromiumLogin: fakeChromium({ found: { CNBSESSION: SESSION } }),
    // 一开始就有组织 ⇒ 走不到「顺手建组织」那一支
    fetchTopGroups: async () => [{ path: "acme" }],
    listRepos: async () => [],
    createRepo: async () => {
      made.push(1)
      return { ok: true, status: 201, body: {} }
    },
  })

  const result = await loginViaBrowser({}, ctx)

  assert.equal(result.type, "success")
  assert.equal(made.length, 0, "用户自己的空组织可能是故意的，不要替人建仓")
  assert.equal(result.org, "acme")
  assert.equal(result.repo, "acme/code", "没有仓库时仍然按约定猜一个路径，好让报错指向它")
})
