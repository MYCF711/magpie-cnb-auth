// 账号名的语义锁：打码、ID 识别、名字与身份分离。
//
// 这一块出事的样子是「卡片上三串看不懂的 ID」，不报错、不崩，用户只会以为插件坏了
// （真实事故：CodeArts 0.2.4 拿 principal_urn 当账号名）。所以每条都要锁住。

import { test } from "node:test"
import assert from "node:assert/strict"

const { maskPhone, looksLikeIdentifier, accountLabelOf, resolveAccount } = await import(
  "../src/account-name.mjs"
)

test("maskPhone：0086- / +86 / 裸号 / 已打码，一律 3+4", () => {
  // 华为云 IAM 的原始形状（实测 0086-13800138000）
  assert.equal(maskPhone("0086-13800138000"), "138****8000")
  assert.equal(maskPhone("+86 138 0013 8000"), "138****8000")
  assert.equal(maskPhone("13800138000"), "138****8000")
  // 厂商已经打过码的值：不能被二次破坏
  assert.equal(maskPhone("138****8000"), "138****8000")
  assert.equal(maskPhone("138****8000"), "138****8000")
  // 不是号码形状 → 空串，让调用方回退，而不是显示半截
  assert.equal(maskPhone(""), "")
  assert.equal(maskPhone(undefined), "")
  assert.equal(maskPhone("123"), "")
  // 短号没有「前3后4」可打：原号码的全部数字都会出现在结果里 → 必须返回空串
  assert.equal(maskPhone("1234567"), "", "7 位短号打码会泄露全部数字")
  assert.equal(maskPhone("12345678"), "", "8 位短号打码会泄露全部数字")
  assert.equal(maskPhone("8612345678"), "", "8 位短号，不是手机号")
  assert.equal(maskPhone("0086-1898051"), "", "0086 后面只有 7 位，不是手机号")
  assert.equal(maskPhone("86123456789"), "861****6789", "11 位、本身以 86 开头的号码不能被误剥国家码")
})

test("looksLikeIdentifier：这些都不许当名字", () => {
  // IAM 的 URN（真实值）
  assert.equal(looksLikeIdentifier("iam::00000000000000000000000000000000:user:hw000000000000000"), true)
  assert.equal(looksLikeIdentifier("arn:aws:iam::123:user/x"), true)
  assert.equal(looksLikeIdentifier("urn:ietf:params:oauth:jwt"), true)
  // 华为 IAM 的账号名
  assert.equal(looksLikeIdentifier("hw000000000000000"), true)
  // uuid / 裸 hash
  assert.equal(looksLikeIdentifier("0d1606bf-9a1c-4c2e-8b7d-1234567890ab"), true)
  assert.equal(looksLikeIdentifier("00000000000000000000000000000000"), true)
  // 真的名字 / 邮箱 / 短 id：都不该误判
  assert.equal(looksLikeIdentifier("张三"), false)
  assert.equal(looksLikeIdentifier("a@b.com"), false)
  assert.equal(looksLikeIdentifier("1798171953"), false, "纯数字短 id 仍可当名字")
  assert.equal(looksLikeIdentifier("hw"), false)
  assert.equal(looksLikeIdentifier(""), false)
})

test("resolveAccount：accountId 是人看的名字，uid 是身份", () => {
  const urn = "iam::00000000000000000000000000000000:user:hw000000000000000"
  // 有手机号：打码当名字，URN 进 uid —— 这就是 CodeArts 0.2.5 的形状
  assert.deepEqual(resolveAccount({ phone: "0086-13800138000", name: "hw000000000000000", urn }), {
    accountId: "138****8000",
    uid: urn,
  })
  // 没手机号：真人名可以当名字
  assert.deepEqual(resolveAccount({ name: "张三", urn }), { accountId: "张三", uid: urn })
  // 没手机号、名字又像 ID：不给 accountId（宿主回退供应商名），绝不拿 URN 顶上
  assert.deepEqual(resolveAccount({ name: "hw000000000000000", urn }), { uid: urn })
  // 什么都没有：空对象，不编造
  assert.deepEqual(resolveAccount(), {})
  assert.deepEqual(resolveAccount({}), {})
})

test("accountLabelOf：手机号优先于任何 id 字段，短号不当作手机号显示", () => {
  const info = { phone: "0086-13800138000", email: "x@y.com", accountId: "iam::d1:user:hw0001" }
  assert.equal(accountLabelOf(info), "138****8000")
  // 短号不是手机号：跳过它，回退到邮箱（不能把 1234567 原样显示）
  assert.equal(accountLabelOf({ phone: "1234567", email: "x@y.com" }), "x@y.com")
  // 邮箱优先于「像 ID」的 id
  assert.equal(accountLabelOf({ email: "x@y.com", accountId: "iam::d1:user:hw0001" }), "x@y.com")
  // 只剩 ID：空串
  assert.equal(accountLabelOf({ accountId: "iam::d1:user:hw0001" }), "")
})