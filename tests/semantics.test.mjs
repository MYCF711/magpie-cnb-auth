// tests/semantics.test.mjs —— 锁住「形状对、语义错」的那几处
//
// `scripts/check.mjs` 查的是**形状**；真实踩过的坑几乎都在语义上，而且都不报错：
//   · 上游只吃 stream:true，发非流式会拿到业务码 11101
//   · tools 不能透传（上游 403 Agent calls are not allowed），但那个 403 长得像登录问题
//   · 额度窗口写错不报错，只让卡片显示「剩余额度未知」、让这个号在路由里不存在
//   · 能力字段写成字符串 / 省略，会被宿主按别家同名模型补齐
//
// 全部离线；所有网络都用桩替换。
// 跑法：node --test tests/semantics.test.mjs

import test from "node:test"
import assert from "node:assert/strict"

import {
  buildCookieFetch,
  cleanPayload,
  codeForStatus,
  foldSse,
  pickTransport,
  relayBase,
  statusForUpstream,
  wantsTools,
} from "../src/chat.mjs"
import { describeCredentialShape, explainCredentialShape, identifyCredential, shapeKind } from "../src/credential.mjs"
import { buildCreditView, buildUsage, milliToCredit, nextMonthReset, numberOrNull } from "../src/usage.mjs"
import { badgesFromCreditDesc, badgesFromUser, planOf } from "../src/badges.mjs"
import { pollDeviceToken, refreshAccessToken, requestDeviceCode } from "../src/device.mjs"
import { normaliseOptions } from "../src/options.mjs"
import { interpretClaim } from "../src/checkin.mjs"

const SESSION = "123456.789012.0123456789abcdef0123456789abcdef"
const PAT = `cnb_at_${"a".repeat(80)}`

/** 临时替换全局 fetch；无论成败都还原。 */
async function withFetch(impl, fn) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

function sseResponse(text, headers = {}) {
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream", ...headers } })
}

// ── 请求体改写：这几个字段透传上去就是 4xx ─────────────────────────────

test("cleanPayload：强制 stream:true，删掉上游明令禁止的四个字段", () => {
  const original = { model: "m", stream: false, tools: [{}], tool_choice: "auto", response_format: {}, stream_options: {} }
  const clean = cleanPayload(original)
  assert.equal(clean.stream, true, "上游只吃 stream:true（非流式回业务码 11101）")
  for (const key of ["tools", "tool_choice", "response_format", "stream_options"]) {
    assert.equal(key in clean, false, `${key} 必须剥掉，否则整条请求被上游拒`)
  }
  assert.equal("tools" in original, true, "不许改动调用方传进来的对象")
})

test("wantsTools：非空数组才算；空数组 / undefined 不算", () => {
  assert.equal(wantsTools({ tools: [{}] }), true)
  assert.equal(wantsTools({ tools: [] }), false)
  assert.equal(wantsTools({}), false)
  assert.equal(wantsTools(null), false)
})

// ── 通道选择 ──────────────────────────────────────────────────────────

test("pickTransport：显式配置优先，auto 的顺序是 relay → cookie", () => {
  const relayOptions = normaliseOptions({ relay: { url: "https://relay.example/v1" } })
  const cookieAccount = { session: SESSION }

  assert.equal(pickTransport(cookieAccount, relayOptions), "relay", "auto：配了 relay 就用 relay")
  assert.equal(pickTransport(cookieAccount, normaliseOptions({})), "cookie", "auto：没 relay 但有 session")
  assert.equal(pickTransport({ session: "" }, normaliseOptions({})), "none")
  assert.equal(pickTransport({ session: "" }, normaliseOptions({ transport: "cookie" })), "none")
  assert.equal(pickTransport(cookieAccount, normaliseOptions({ transport: "relay" })), "none", "指定 relay 却没填 url")
})

test("relayBase：去掉尾斜杠与 /v1（SDK 自己会拼 /chat/completions）", () => {
  assert.equal(relayBase("https://relay.example/v1/"), "https://relay.example")
  assert.equal(relayBase("https://relay.example"), "https://relay.example")
  assert.equal(relayBase(""), "")
})

// ── 状态码 / code 映射 ────────────────────────────────────────────────

test("statusForUpstream：4xx 透传，5xx 落 503（别拿 502 表示超时——那不可重试）", () => {
  assert.equal(statusForUpstream(400), 400)
  assert.equal(statusForUpstream(401), 401)
  assert.equal(statusForUpstream(404), 404)
  assert.equal(statusForUpstream(429), 429)
  assert.equal(statusForUpstream(500), 503)
  assert.equal(statusForUpstream(403), 502)
})

test("codeForStatus：每个 status 都落到词表里的一个 code", () => {
  assert.equal(codeForStatus(400), "invalid_request")
  assert.equal(codeForStatus(401), "session_expired")
  assert.equal(codeForStatus(404), "model_not_found")
  assert.equal(codeForStatus(429), "rate_limited")
  assert.equal(codeForStatus(503), "upstream_unavailable")
  assert.equal(codeForStatus(418), "upstream_error")
})

// ── cookie 通道的三个出口 ─────────────────────────────────────────────

test("cookie 通道：带 tools 直接 501（不透传——上游那个 403 会被当成登录失效）", async () => {
  const pluginFetch = buildCookieFetch({
    getAuth: async () => ({ type: "api", key: SESSION }),
    options: normaliseOptions({ repo: "acme/code" }),
  })
  const res = await pluginFetch("https://cnb.cool/acme/code/-/ai/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "deepseek-v4.1-flash", stream: true, tools: [{ type: "function", function: { name: "x" } }] }),
  })
  assert.equal(res.status, 501)
  const body = await res.json()
  assert.equal(body.error.code, "not_implemented")
  assert.match(body.error.message, /relay/)
})

test("cookie 通道：没有仓库路径时给 400，而不是发一个必然 404 的请求", async () => {
  const pluginFetch = buildCookieFetch({
    getAuth: async () => ({ type: "api", key: SESSION }),
    options: normaliseOptions({}),
  })
  const res = await pluginFetch("https://cnb.cool/-/ai/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "deepseek-v4.1-flash" }),
  })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).error.code, "invalid_request")
})

test("cookie 通道：非流式请求由插件折叠 SSE，并恒以 stream:true 发上游", async () => {
  let seen = null
  const pluginFetch = buildCookieFetch({
    getAuth: async () => ({ type: "api", key: SESSION }),
    options: normaliseOptions({ repo: "acme/code" }),
  })

  const sse = [
    'data: {"id":"c1","model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"content":"你"}}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"好"},"finish_reason":"stop"}]}',
    "data: [DONE]",
    "",
  ].join("\n\n")

  await withFetch(
    async (url, init) => {
      seen = { url: String(url), init }
      return sseResponse(sse)
    },
    async () => {
      const res = await pluginFetch("https://cnb.cool/acme/code/-/ai/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "deepseek-v4.1-flash", stream: false }),
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.object, "chat.completion")
      assert.equal(body.choices[0].message.content, "你好")
      assert.equal(body.choices[0].finish_reason, "stop")
    },
  )

  assert.match(seen.url, /acme\/code\/-\/ai\/chat\/completions$/)
  assert.match(seen.init.headers.cookie, /CNBSESSION=/)
  assert.match(seen.init.headers["user-agent"], /magpie-cnb-auth\//, "缺 UA 会被 Cloudflare 回 403 Error 1010")
  assert.equal(JSON.parse(seen.init.body).stream, true, "上游只吃流式")
})

test("foldSse：直接喂 SSE 也能折叠成一条 message", async () => {
  const res = sseResponse('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  const folded = await foldSse(res, "deepseek-v4.1-flash")
  assert.equal(folded.choices[0].message.content, "hi")
  assert.equal(folded.model, "deepseek-v4.1-flash")
})

// ── 凭据识别 ──────────────────────────────────────────────────────────

test("凭证形态：PAT 与 CNBSESSION 互斥可判，别靠猜", () => {
  const pat = describeCredentialShape(PAT)
  assert.equal(pat.hasAccessTokenPrefix, true)
  assert.equal(pat.sessionLike, false)

  const session = describeCredentialShape(SESSION)
  assert.equal(session.sessionLike, true)
  assert.equal(session.hasAccessTokenPrefix, false)

  assert.equal(shapeKind(PAT).kind, "pat")
  assert.equal(shapeKind(SESSION).kind, "session")
  assert.equal(shapeKind("sk-something").kind, "unknown")
})

test("凭证形态错误时说清「你粘的是什么」，而不是只说「无效」", () => {
  const text = explainCredentialShape(describeCredentialShape("sk-abc"))
  assert.match(text, /个字符/)
  assert.match(text, /没有点号分段|段/)
})

test("两种都不像时给出可照做的指引（含生成地址）", async () => {
  // 让「当令牌试一次」得到 401，从而落到「都不是」那个分支
  await withFetch(
    async () => new Response(JSON.stringify({ errcode: 401, errmsg: "unauthorized" }), { status: 401 }),
    async () => {
      await assert.rejects(
        () => identifyCredential("sk-nope", {}),
        (error) => {
          assert.equal(error.status, 401)
          assert.match(error.message, /cnb_at_/)
          assert.match(error.message, /cnb\.cool\/profile\/token/)
          return true
        },
      )
    },
  )
})

// ── 额度 ──────────────────────────────────────────────────────────────

test("money：毫 Credit → Credit 保留两位；非数字一律 null（不猜成 0）", () => {
  assert.equal(milliToCredit(500_000), 500)
  assert.equal(milliToCredit(1_234), 1.23)
  assert.equal(milliToCredit(null), null)
  assert.equal(numberOrNull(""), null)
  assert.equal(numberOrNull("12"), 12)
})

test("重置时间是下月 1 日 0 点的 ISO 字符串（不是厂商原样格式）", () => {
  const iso = nextMonthReset(new Date("2026-11-02T23:10:00Z"))
  assert.equal(iso, "2026-12-01T00:00:00.000Z")
  assert.equal(Number.isNaN(Date.parse(iso)), false)
})

test("buildCreditView：privilege = total - free；缺字段就是 null", () => {
  const view = buildCreditView(
    { credit_in_milli: { total: 600_000, free: 500_000 } },
    { credit_in_milli: 120_000, freeze_credit_in_milli: 0 },
    { credit: 3000, credit_desc: "天才程序员专属特权", credit_expire: "2026-12-31T00:00:00Z" },
  )
  assert.equal(view.total, 600)
  assert.equal(view.free, 500)
  assert.equal(view.used, 120)
  assert.equal(view.privilege, 100)
  assert.equal(view.special, 3000)
  assert.match(view.specialDesc, /天才/)

  const empty = buildCreditView(null, null, null)
  assert.equal(empty.total, null)
  assert.equal(empty.used, null)
})

test("buildUsage：有 total + used 时给一条真正参与路由的窗口", () => {
  const credit = buildCreditView({ credit_in_milli: { total: 500_000, free: 500_000 } }, { credit_in_milli: 100_000 }, null)
  const value = buildUsage({ credit, badges: [{ label: "天才老师" }], transport: "cookie", username: "acme" })

  assert.equal(value.plan, "天才老师")
  assert.equal(value.user, "acme")
  const share = value.windows.find((w) => w.used !== undefined && w.aside !== true)
  assert.ok(share, "必须有一条带 used 的窗口，否则这个号在路由里等于不存在")
  assert.equal(share.used, 20)
  assert.equal(share.limit, 500)
  assert.equal(typeof share.resetsAt, "string")
})

test("buildUsage：一个数字都没有时给 error + 空窗口，绝不伪造 0%", () => {
  const value = buildUsage({ credit: buildCreditView(null, null, null), badges: [], transport: "none", org: "" })
  assert.equal(typeof value.error, "string")
  assert.deepEqual(value.windows, [], "伪造 0% 会让空号排到路由队首")
})

// ── 徽章 ──────────────────────────────────────────────────────────────

test("徽章：genius + edu 合并成「天才X」，不显示两枚", () => {
  const badges = badgesFromUser({ identity_providers: { genius: {}, edu: { identity_type: "TEACHER" } } })
  assert.equal(badges.length, 1)
  assert.equal(badges[0].label, "天才老师")
  assert.equal(badges[0].kind, "combined")
})

test("徽章：内测 / 开服 / TDP 分别成条", () => {
  const badges = badgesFromUser({
    identity_providers: { obt_player: {}, day_one_player: {}, tdp: { tdp_primary_tag: "Silver" } },
  })
  const labels = badges.map((b) => b.label)
  assert.deepEqual(labels, ["内测玩家", "开服玩家", "TDP Silver"])
})

test("徽章兜底：identity_providers 为 null 时从特权额度说明里认，且不重复补", () => {
  const fromDesc = badgesFromCreditDesc("天才程序员专属特权", [])
  assert.equal(fromDesc.length, 1)
  assert.equal(fromDesc[0].label, "天才程序员")
  assert.equal(fromDesc[0].source, "特权额度说明")

  const existing = badgesFromUser({ identity_providers: { genius: {} } })
  assert.equal(badgesFromCreditDesc("天才程序员专属特权", existing).length, 1, "已有同 kind 就不再补")
})

test("planOf：没有徽章时退回「CNB 免费额度」", () => {
  assert.equal(planOf([]), "CNB 免费额度")
  assert.equal(planOf([{ label: "高校学生" }]), "高校学生")
})

// ── 选项归一化 ────────────────────────────────────────────────────────

test("normaliseOptions：容忍任何输入（undefined / 字符串 / 空对象）", () => {
  const a = normaliseOptions(undefined)
  assert.equal(a.transport, "auto")
  assert.equal(a.relay.url, "")
  assert.equal(a.claim.method, "POST")
  assert.equal(a.claim.body, "{}")
  assert.equal(a.repoName, "code")

  const b = normaliseOptions({ org: "/acme/", repo: "/acme/repo/", transport: "COOKIE", relay: "" })
  assert.equal(b.org, "acme")
  assert.equal(b.repo, "acme/repo")
  assert.equal(b.transport, "cookie")
  assert.equal(b.relay.url, "", "relay 被存成空串时不能炸")

  assert.equal(normaliseOptions({ transport: "banana" }).transport, "auto")
})

// ── 设备码登录 ────────────────────────────────────────────────────────

test("申请设备码：解析 RFC 8628 的字段（实测形状）", async () => {
  await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          device_code: "cnb_dc_x",
          user_code: "dMEfLnQj",
          verification_uri: "https://cnb.cool/oauth2/device/verify",
          verification_uri_complete: "https://cnb.cool/oauth2/device/verify?user_code=dMEfLnQj",
          expires_in: 600,
          interval: 5,
        }),
        { status: 200 },
      ),
    async () => {
      const dev = await requestDeviceCode({})
      assert.equal(dev.deviceCode, "cnb_dc_x")
      assert.equal(dev.userCode, "dMEfLnQj")
      assert.equal(dev.expiresIn, 600)
      assert.equal(dev.interval, 5)
      assert.match(dev.verificationUriComplete, /user_code=dMEfLnQj/)
    },
  )
})

test("轮询：先 pending 再成功 —— pending 不是错误，是状态", async () => {
  let calls = 0
  await withFetch(
    async () => {
      calls += 1
      if (calls === 1) return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 })
      return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 28_800 }), { status: 200 })
    },
    async () => {
      const token = await pollDeviceToken({ platform: "https://cnb.cool", clientId: "cnb_cli", deviceCode: "d", expiresIn: 60, interval: 0 })
      assert.equal(token.access_token, "at")
      assert.equal(calls, 2)
    },
  )
})

test("轮询：denied 与 expired 各自有话说", async () => {
  await withFetch(
    async () => new Response(JSON.stringify({ error: "access_denied" }), { status: 400 }),
    async () => {
      await assert.rejects(
        () => pollDeviceToken({ platform: "https://cnb.cool", clientId: "cnb_cli", deviceCode: "d", expiresIn: 60, interval: 0 }),
        /拒绝/,
      )
    },
  )

  await withFetch(
    async () => new Response(JSON.stringify({ error: "expired_token" }), { status: 400 }),
    async () => {
      await assert.rejects(
        () => pollDeviceToken({ platform: "https://cnb.cool", clientId: "cnb_cli", deviceCode: "d", expiresIn: 60, interval: 0 }),
        /过期/,
      )
    },
  )
})

test("续期：拿到新令牌就返回合并结果；invalid_grant 抛 signIn: expired", async () => {
  await withFetch(
    async () => new Response(JSON.stringify({ access_token: "new", refresh_token: "rt2", expires_in: 28_800 }), { status: 200 }),
    async () => {
      const next = await refreshAccessToken({ refresh: "rt1" })
      assert.equal(next.access, "new")
      assert.equal(next.refresh, "rt2", "服务端轮换了就用新的")
      assert.ok(next.expires > Date.now())
    },
  )

  await withFetch(
    async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    async () => {
      await assert.rejects(() => refreshAccessToken({ refresh: "rt1" }), (error) => {
        assert.equal(error.signIn, "expired")
        return true
      })
    },
  )
})

// ── 签到 ──────────────────────────────────────────────────────────────

test("claim 返回体：已领过 / 验证码 / 成功 各自落到正确的 outcome", () => {
  assert.equal(interpretClaim({ already: true }, 200).outcome, "done")
  assert.equal(interpretClaim({ need_captcha: true }, 200).outcome, "captcha")
  const ok = interpretClaim({ credit: 50, streak: 3, message: "ok" }, 200)
  assert.equal(ok.outcome, "claimed")
  assert.equal(ok.credit, 50)
  assert.equal(ok.streak, 3)
  assert.equal(interpretClaim({ errmsg: "no" }, 401).outcome, "ineligible")
})
