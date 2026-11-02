// tests/credential-kind.test.mjs —— resolveAccount 的凭据种类判定
//
// 锁一条回归：「受控浏览器只拿到 CNBSESSION」时，`kind` 曾经被 `auth.type === "oauth"`
// 强行判成 `pat` —— 于是 `token` 是那条 session（打 api.cnb.cool 必然 401）、
// 而 `session` 反而空着（模型通道是空的）。一半坏一半好的错最难查，所以单独锁一条。

import test from "node:test"
import assert from "node:assert/strict"

import { clearCredentialCache, resolveAccount } from "../src/credential.mjs"

/** 形状合法的 CNBSESSION（三段：数字.数字.<长 hex>） */
const SESSION = "123456.789012.0123456789abcdef0123456789abcdef"
/** 形状合法的访问令牌 */
const PAT = "cnb_at_" + "a".repeat(40)

test("浏览器登录只拿到 CNBSESSION：kind = session，绝不能按 oauth 判成 pat", () => {
  clearCredentialCache()
  const account = resolveAccount({ type: "oauth", access: SESSION, metadata: {} })

  assert.equal(account.kind, "session")
  assert.equal(account.session, SESSION)
  assert.equal(account.token, "", "session 不是 PAT：拿它查额度必然 401")
})

test("两样凭据都在：PAT 进 token（查额度），CNBSESSION 进 session（跑模型）", () => {
  clearCredentialCache()
  const account = resolveAccount({
    type: "oauth",
    access: PAT,
    metadata: { kind: "pat", session: SESSION, csrfkey: "csrf-key" },
  })

  assert.equal(account.kind, "pat")
  assert.equal(account.token, PAT)
  assert.equal(account.session, SESSION)
  assert.equal(account.csrfkey, "csrf-key")
})

test("没有 metadata 时退回凭据形状判断", () => {
  clearCredentialCache()
  assert.equal(resolveAccount({ type: "api", key: PAT }).kind, "pat")
  assert.equal(resolveAccount({ type: "api", key: SESSION }).kind, "session")
})
