// 本机浏览器 localStorage：同一 origin 内配对、跨 origin 不串
import test from "node:test"
import assert from "node:assert/strict"

import { _internal } from "../src/local-browser.mjs"

const jwt = (iat, exp) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${b64({ alg: "HS256" })}.${b64({ iat, exp, sub: "x" })}.sig`
}

test("同一 origin 的 jwt 配自己后面的 organizationCode", () => {
  const a = jwt(100, 9999999999)
  const text = [
    `_https://a.example.com\x00\x01authorization{"key":"authorization","value":"${a}"}`,
    `_https://a.example.com\x00\x01organizationCode{"key":"organizationCode","value":"orgA123"}`,
  ].join("\x00")
  const got = _internal.credsNear(text, "a.example.com")
  assert.equal(got.length, 1)
  assert.equal(got[0].org, "orgA123")
})

test("两个 origin 相邻时不串（A 的 jwt 不能配到 B 的 org）", () => {
  const a = jwt(100, 9999999999)
  const b = jwt(200, 9999999999)
  const text = [
    `_https://a.example.com\x00\x01authorization{"key":"authorization","value":"${a}"}`,
    `_https://b.example.com\x00\x01authorization{"key":"authorization","value":"${b}"}`,
    `_https://b.example.com\x00\x01organizationCode{"key":"organizationCode","value":"orgB456"}`,
  ].join("\x00")
  const gotA = _internal.credsNear(text, "a.example.com")
  const gotB = _internal.credsNear(text, "b.example.com")
  assert.equal(gotA.length, 0, "A 没有 org，不能拿 B 的")
  assert.equal(gotB.length, 1)
  assert.equal(gotB[0].org, "orgB456")
})

test("jwt 的 iat/exp 能解出来；坏 token 返回 0", () => {
  const t = jwt(1700000000, 1800000000)
  assert.deepEqual(_internal.jwtTimes(t), { iat: 1700000000, exp: 1800000000 })
  assert.deepEqual(_internal.jwtTimes("not-a-jwt"), { iat: 0, exp: 0 })
})

test("organizationCode2 也认（同一 key 的不同版本）", () => {
  const a = jwt(100, 9999999999)
  const text = `_https://a.example.com\x00\x01authorization{"key":"authorization","value":"${a}"}` +
    `\x00_https://a.example.com\x00\x01organizationCode2{"key":"organizationCode","value":"org2"}` 
  const got = _internal.credsNear(text, "a.example.com")
  assert.equal(got[0]?.org, "org2")
})