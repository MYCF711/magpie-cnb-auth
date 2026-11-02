// tests/org.test.mjs —— 组织 slug 生成 + 「用网页登录态建组织」的请求形状
//
// ⚠ 建组织**没有真机证据**（本机没有可用的 CNBSESSION），所以这里锁的全是**离线可验**的部分：
//   请求打哪儿、带什么头、body 对不对、失败时绝不抛。它能不能用 cookie 过鉴权，
//   只有等有 CNBSESSION 的账号跑一次才知道。

import test from "node:test"
import assert from "node:assert/strict"

import { createGroupWithSession, orgHint, suggestGroupPath } from "../src/org.mjs"

/** 形状合法的 CNBSESSION（三段：数字.数字.<长 hex>），不会打任何网络请求 */
const SESSION = "123456.789012.0123456789abcdef0123456789abcdef"

/** 一个最小的 Response 替身：createGroupWithSession 只用到 ok / status / text() */
function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body)
    },
  }
}

/** CNB 的组织 slug 规则：小写字母数字与 `-`，长度 2~30，首尾不能是 `-` */
function assertLegalSlug(slug, label = "slug") {
  assert.match(slug, /^[a-z0-9][a-z0-9-]{1,29}$/, `${label} 不合法：${JSON.stringify(slug)}`)
  assert.ok(!slug.includes("--"), `${label} 出现了连续 -：${slug}`)
  assert.ok(!slug.startsWith("-") && !slug.endsWith("-"), `${label} 首尾不能是 -：${slug}`)
}

// ── suggestGroupPath ────────────────────────────────────────────────

test("suggestGroupPath：CNB 自动用户名 → 合法 slug", () => {
  // 实测（2026-11-02）：新账号的 username 就是这种形状，带点号、大小写混排
  const slug = suggestGroupPath("cnb.dI2DzHg0QHA")
  assert.equal(slug, "di2dzhg0qha", "cnb. 前缀是系统标记、要丢掉；其余原样小写")
  assertLegalSlug(slug)
})

test("suggestGroupPath：昵称优先，正常名字原样小写", () => {
  assert.equal(suggestGroupPath("Tlaloc"), "tlaloc")
  assert.equal(suggestGroupPath("  My Org!! 2026  "), "my-org-2026")
})

test("suggestGroupPath：连续非法字符只留一个 -，首尾的 - 掐掉", () => {
  assert.equal(suggestGroupPath("a---b__c...d"), "a-b-c-d")
  assert.equal(suggestGroupPath("--Hello   World--"), "hello-world")
  for (const src of ["a---b", "__x__", "A  B"]) assertLegalSlug(suggestGroupPath(src), src)
})

test("suggestGroupPath：超长截到 30，中文/太短用兜底", () => {
  const long = suggestGroupPath("A".repeat(80))
  assert.equal(long.length, 30)
  assertLegalSlug(long, "超长名字")

  // 纯中文昵称一个字符都留不下 → 固定兜底（不能让用户因为名字是中文就建不了组织）
  assert.equal(suggestGroupPath("张三"), "cnb-user")
  assert.equal(suggestGroupPath(""), "cnb-user")
  assert.equal(suggestGroupPath(undefined), "cnb-user")
  // 只有一个字符也不够 2 位
  assert.equal(suggestGroupPath("x"), "cnb-user")
})

test("suggestGroupPath：撞名加 -code，再撞加 -code-2", () => {
  assert.equal(suggestGroupPath("Tlaloc", { taken: ["tlaloc"] }), "tlaloc-code")
  assert.equal(suggestGroupPath("Tlaloc", { taken: ["Tlaloc", "TLALOC-CODE"] }), "tlaloc-code-2")

  // 超长 + 撞名：后缀要挤在 30 以内
  const base = "b".repeat(30)
  const withTail = suggestGroupPath(base, { taken: [base] })
  assert.ok(withTail.length <= 30, `加了后缀还是不能超过 30：${withTail.length}`)
  assert.ok(withTail.endsWith("-code"), withTail)
  assertLegalSlug(withTail, "超长+撞名")
})

// ── createGroupWithSession ──────────────────────────────────────────

test("createGroupWithSession：POST https://api.cnb.cool/groups，头与 body 都对", async () => {
  const seen = []
  const result = await createGroupWithSession({
    session: SESSION,
    csrfToken: "csrf-token",
    csrfkey: "csrf-key",
    path: "tlaloc",
    description: "由 magpie 的 CNB 插件创建",
    fetch: async (url, init) => {
      seen.push({ url, init })
      return fakeResponse(201, { path: "tlaloc", id: 7 })
    },
  })

  assert.deepEqual(result, { ok: true, status: 201, body: { path: "tlaloc", id: 7 } })
  assert.equal(seen.length, 1)

  const { url, init } = seen[0]
  assert.equal(url, "https://api.cnb.cool/groups")
  assert.equal(init.method, "POST")

  const headers = init.headers
  assert.equal(headers.cookie, `CNBSESSION=${SESSION}; csrfkey=csrf-key`)
  assert.equal(headers.csrftoken, "csrf-token", "Csrftoken 用页面里的 csrftoken")
  assert.equal(headers.origin, "https://cnb.cool")
  assert.equal(headers.referer, "https://cnb.cool/")
  assert.equal(headers["content-type"], "application/json")
  // 缺 UA 会被 Cloudflare 判 bot（403 Error 1010，HTML 响应）—— 所以它是硬要求
  assert.match(headers["user-agent"], /^magpie-cnb-auth\//)

  assert.deepEqual(JSON.parse(init.body), { path: "tlaloc", description: "由 magpie 的 CNB 插件创建" })
})

test("createGroupWithSession：没有 csrftoken 时退回 csrfkey；两个都没有就不带这个头", async () => {
  const headersOf = async (args) => {
    let captured = null
    await createGroupWithSession({ ...args, fetch: async (_url, init) => ((captured = init.headers), fakeResponse(201, {})) })
    return captured
  }

  assert.equal((await headersOf({ session: SESSION, csrfkey: "only-key", path: "a1" })).csrftoken, "only-key")
  assert.equal((await headersOf({ session: SESSION, path: "a1" })).csrftoken, undefined)
  // 没有 csrfkey 就不该往 Cookie 里塞它
  assert.equal((await headersOf({ session: SESSION, path: "a1" })).cookie, `CNBSESSION=${SESSION}`)
})

test("createGroupWithSession：403 不抛，原样把 status 与 body 交回去", async () => {
  const result = await createGroupWithSession({
    session: SESSION,
    path: "tlaloc",
    fetch: async () => fakeResponse(403, { errcode: 403, errmsg: "User has no permission." }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 403)
  assert.equal(result.body.errmsg, "User has no permission.")
})

test("createGroupWithSession：网络断了也不抛（status 0 + 原因）", async () => {
  const result = await createGroupWithSession({
    session: SESSION,
    path: "tlaloc",
    fetch: async () => {
      throw new Error("getaddrinfo ENOTFOUND api.cnb.cool")
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 0)
  assert.match(result.body.errmsg, /ENOTFOUND/)
})

test("createGroupWithSession：上游回 HTML 也不会崩（readBody 收成文本）", async () => {
  const result = await createGroupWithSession({
    session: SESSION,
    path: "tlaloc",
    fetch: async () => ({ ok: false, status: 502, text: async () => "<html>Bad Gateway</html>" }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 502)
  assert.match(String(result.body._text), /Bad Gateway/)
})

test("createGroupWithSession：缺 session / 缺 slug 直接回，不发请求", async () => {
  let called = 0
  const fetch = async () => ((called += 1), fakeResponse(201, {}))

  const noSession = await createGroupWithSession({ path: "tlaloc", fetch })
  assert.equal(noSession.ok, false)
  assert.equal(noSession.status, 0)
  assert.match(noSession.body.errmsg, /CNBSESSION/)

  const noPath = await createGroupWithSession({ session: SESSION, fetch })
  assert.equal(noPath.ok, false)
  assert.match(noPath.body.errmsg, /slug/)

  assert.equal(called, 0, "参数不全时不该发请求")
})

// ── orgHint（卡片上那句「还没有组织」）────────────────────────────────

test("orgHint：有 session 没组织时指出「浏览器网页登录」能顺带建组织", () => {
  const hint = orgHint({ noOrg: true, session: SESSION, token: "cnb_at_x" }, {})
  assert.match(hint, /还没有组织/)
  assert.match(hint, /浏览器网页登录/)
  assert.match(hint, /顺带建组织/)
})

test("orgHint：只有网页登录态时额外说清额度还差访问令牌", () => {
  const hint = orgHint({ noOrg: true, session: SESSION, token: "" }, {})
  assert.match(hint, /访问令牌/)
  assert.match(hint, /profile\/token/)
})

test("orgHint：上次建组织失败过就按 status 说话，别让人反复点", () => {
  const hint = orgHint(
    { noOrg: true, session: SESSION, token: "cnb_at_x" },
    { metadata: { orgAttempt: { ok: false, status: 403, message: "User has no permission." } } },
  )
  assert.match(hint, /HTTP 403/)
  assert.match(hint, /没有权限|no permission/i)
  assert.match(hint, /cnb\.cool\/new\/groups/)
})

test("orgHint：不适用时返回空串（有组织 / 没 session）", () => {
  assert.equal(orgHint({ noOrg: false, session: SESSION, token: "" }, {}), "")
  assert.equal(orgHint({ noOrg: true, session: "", token: "" }, {}), "")
  assert.equal(orgHint(null, null), "")
})
