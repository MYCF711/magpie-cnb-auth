// src/desktop-import.mjs —— 从本机 Electron 客户端导入登录态（Windows）
//
// ═══════════════════════════════════════════════════════════════════
// 什么时候值得做
// ═══════════════════════════════════════════════════════════════════
//
// 厂商有桌面客户端、客户端登录后把 token 存在本地时，这是**最省事的一条登录路**：
// 用户已经在客户端登录过，插件直接读过来 —— 不弹浏览器、不过验证码、不用重登。
// 实测（2026-10-29，Accio 官方 Windows 客户端 Electron 41）：
//
//   %APPDATA%\Accio\credentials.enc      ← 当前账号的 accessToken / refreshToken / expiresAt / sgcookie
//   %APPDATA%\Accio\Local State          ← os_crypt.encrypted_key（DPAPI 包着 32 字节 AES key）
//
// 这两份与网站 OAuth 拿到的**是同一套 token**（同网关、同接口）。所以这条路不是
// 「绕过登录」，是「复用用户已经登录过的事实」。
//
// ═══════════════════════════════════════════════════════════════════
// 加密格式（Chromium OSCrypt，实测）
// ═══════════════════════════════════════════════════════════════════
//
//   Local State:  os_crypt.encrypted_key = base64("DPAPI" + DPAPI(32-byte key))
//   credentials.enc:  "v10" + nonce(12) + ciphertext + tag(16)     ← AES-256-GCM
//
//   ⇒ 先 DPAPI(CurrentUser) 解出 key（借 PowerShell 一次，约 0.3 秒），再 AES-GCM 解文件。
//
// ⚠ 只在 Windows 有效；只在客户端登录过之后有效；解出来的 token **只交给 magpie 的账号槽**，
//   不要写进插件自己的 cache（会与 magpie 的续期分叉）。

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { execFileSync } from "node:child_process"
import { createDecipheriv } from "node:crypto"

/** 客户端数据目录（Electron 的 `app.getPath('userData')`）。 */
export function desktopDataDir(appDataDirName) {
  const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming")
  return join(appData, String(appDataDirName))
}

/** 本机是否装着、且登录过这个客户端。 */
export function hasDesktopLogin(appDataDirName, credentialFile = "credentials.enc") {
  const dir = desktopDataDir(appDataDirName)
  return existsSync(join(dir, credentialFile)) && existsSync(join(dir, "Local State"))
}

/** DPAPI(CurrentUser) 解一段密文 —— 只能 Windows，借 PowerShell。 */
export function dpapiDecrypt(cipher) {
  if (process.platform !== "win32") throw new Error("DPAPI 只在 Windows 上可用")
  const b64 = Buffer.from(cipher).toString("base64")
  const script =
    "Add-Type -AssemblyName System.Security; " +
    "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect(" +
    `[Convert]::FromBase64String('${b64}'), $null, 'CurrentUser'))`
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 20_000,
  })
  return Buffer.from(out.trim(), "base64")
}

/**
 * 解开 Chromium OSCrypt 的 `v10` 文件（AES-256-GCM，key 由 DPAPI 保护）。
 *
 * ⚠ `v11` / `v20` 是 App-Bound Encryption（Chrome 127+ / Edge 新版），DPAPI 解不了，
 *   这里会明确报错而不是给出乱码 —— 遇到它就只能走「浏览器登录」那条路。
 */
export function decryptChromiumV10(file, localStateFile) {
  const data = readFileSync(file)
  const version = data.subarray(0, 3).toString()
  if (version === "v11" || version === "v20") {
    throw new Error(`这个客户端用了 App-Bound 加密（${version}），DPAPI 解不开 —— 请走浏览器登录`)
  }
  if (version !== "v10") throw new Error(`不认识的加密版本：${version}`)

  const ls = JSON.parse(readFileSync(localStateFile, "utf8"))
  const wrapped = Buffer.from(ls?.os_crypt?.encrypted_key ?? "", "base64")
  if (wrapped.subarray(0, 5).toString() !== "DPAPI") throw new Error("Local State 里没有 DPAPI 包装的 key")
  const key = dpapiDecrypt(wrapped.subarray(5))
  if (key.length !== 32) throw new Error(`AES key 长度异常：${key.length}`)

  const nonce = data.subarray(3, 15)
  const body = data.subarray(15)
  const tag = body.subarray(body.length - 16)
  const decipher = createDecipheriv("aes-256-gcm", key, nonce)
  decipher.setAuthTag(tag)
  return JSON.parse(Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8"))
}

/**
 * 读客户端当前账号的登录态，并映射成插件自己的凭据形状。
 *
 * @param {object} o
 * @param {string} o.appDataDirName        如 "Accio"
 * @param {string} [o.credentialFile]       默认 "credentials.enc"
 * @param {(raw:object)=>{credential:object,user:object}} o.map  把客户端结构映射成插件凭据
 * @returns {{credential:object,user:object}|null}
 */
export function importDesktopLogin({ appDataDirName, credentialFile = "credentials.enc", map }) {
  if (process.platform !== "win32") return null
  const dir = desktopDataDir(appDataDirName)
  const file = join(dir, credentialFile)
  if (!existsSync(file)) return null
  const raw = decryptChromiumV10(file, join(dir, "Local State"))
  const mapped = map(raw)
  if (!mapped?.credential?.access_token) return null
  return mapped
}