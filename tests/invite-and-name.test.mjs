// 骨架模块的语义锁：邀请码策略 + 账号名。
// 这两块都是「写错不报错、用户看不出」的类型，所以单独锁。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// 隔离 HOME：策略文件写在 ~/.cache/magpie 下，不能污染真实目录
const sandbox = mkdtempSync(join(tmpdir(), "scaffold-invite-"))
process.env.HOME = sandbox
process.env.USERPROFILE = sandbox

const { createInviteStore, inviteHint, resolveInvite, makeInviteMethod } = await import("../src/invite.mjs")
const { accountLabelOf } = await import("../src/account-name.mjs")

test("resolveInvite：0 / 空 / 1 沿用当前，其它当新码", () => {
  assert.equal(resolveInvite("", "IC1"), "IC1")
  assert.equal(resolveInvite("0", "IC1"), "IC1")
  assert.equal(resolveInvite("1", "IC1"), "IC1")
  assert.equal(resolveInvite("  IC9 ", "IC1"), "IC9")
  assert.equal(resolveInvite(undefined, ""), "")
  // 前端可能传数字
  assert.equal(resolveInvite(0, "IC1"), "IC1")
  assert.equal(resolveInvite(1, "IC1"), "IC1")
})

test("inviteHint：灰色字要说清「当前模式」和「怎么改」", () => {
  assert.match(inviteHint("IC1"), /当前模式：自动（IC1）/)
  assert.match(inviteHint("IC1"), /输入 1/)
  assert.match(inviteHint(""), /直接填/)
})

test("createInviteStore：写读、原子、可整目录删（读失败不抛）", () => {
  const store = createInviteStore("zztest")
  assert.equal(store.read(), "")
  store.write("IC1", { source: "chosen", extra: { sId: "sid-1" } })
  assert.equal(store.read(), "IC1")
  assert.equal(store.readExtra("sId"), "sid-1")
  // 空码不写
  store.write("", { source: "x" })
  assert.equal(store.read(), "IC1")
})

test("createInviteStore：换码必须一起换 extra（不能拿旧 sId 配新码）", () => {
  const store = createInviteStore("zzswap")
  store.write("IC1", { extra: { sId: "sid-1" } })
  // 换码且不给新 sid → 旧 sid 必须丢掉
  store.write("IC2", { extra: {} })
  assert.equal(store.read(), "IC2")
  assert.equal(store.readExtra("sId"), "")
  // 同码重写且不给 sid → 继承旧 sid（幂等）
  store.write("IC2", { extra: { sId: "sid-2" } })
  store.write("IC2", { extra: {} })
  assert.equal(store.readExtra("sId"), "sid-2")
})

test("makeInviteMethod：ask 三步（邀请码 → 主问题 → null），authorize 复用主登录", async () => {
  const store = createInviteStore("zzmethod")
  const mainCalls = []
  const mainMethod = {
    async authorize(inputs) {
      mainCalls.push(inputs)
      return { url: "https://example.invalid/login", method: "auto", callback: async () => ({ type: "success" }) }
    },
  }
  const region = { type: "select", key: "region", message: "站点" }
  const m = makeInviteMethod({
    label: "邀请码",
    mainMethod,
    followUps: [region],
    pick: (inputs) => resolveInvite(inputs.invite, store.read()),
    save: (code) => store.write(code, { source: "chosen" }),
  })

  assert.equal(m.type, "oauth")
  assert.equal((await m.ask({})).key, "invite")
  assert.equal((await m.ask({ invite: "IC1" })).key, "region")
  assert.equal(await m.ask({ invite: "IC1", region: "cn" }), null)

  const out = await m.authorize({ invite: "IC1", region: "cn" })
  assert.equal(out.url, "https://example.invalid/login")
  assert.equal(store.read(), "IC1")
  assert.deepEqual(mainCalls, [{ invite: "IC1", region: "cn" }], "authorize 必须把完整 inputs 交给主登录")
})

test("accountLabelOf：手机号（打码）→ 邮箱 → id → 空串，且不编造", () => {
  assert.equal(accountLabelOf({ maskedMobile: "+86 138****8000", userId: "1" }), "138****8000")
  // 完整号码也要打码：卡片是给人扫一眼的，不是通讯录（规矩 ②）
  assert.equal(accountLabelOf({ mobile: "13800138000" }), "138****8000")
  assert.equal(accountLabelOf({ email: "a@b.com", userId: "1" }), "a@b.com")
  assert.equal(accountLabelOf({ desensitizedEmail: "a***@b.com" }), "a***@b.com")
  assert.equal(accountLabelOf({ userId: "1798171953" }), "1798171953")
  assert.equal(accountLabelOf({}), "")
  assert.equal(accountLabelOf(null), "")
  // 自定义字段名
  assert.equal(accountLabelOf({ tel: "139****0000" }, { mobile: ["tel"] }), "139****0000")
  // 像内部 ID 的值不当名字（规矩 ④）；要它就得显式 allowId
  assert.equal(accountLabelOf({ userId: "iam::d1:user:hw000000000000000" }), "")
  assert.equal(accountLabelOf({ username: "hw000000000000000" }), "")
  assert.equal(accountLabelOf({ userId: "hw000000000000000" }, { allowId: true }), "hw000000000000000")
  // 不打码的老行为仍然可选
  assert.equal(accountLabelOf({ mobile: "13800138000" }, { mask: false }), "13800138000")
})