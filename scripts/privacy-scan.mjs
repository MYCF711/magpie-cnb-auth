#!/usr/bin/env node
/**
 * privacy-scan —— 公开仓库前的脱敏检查。
 *
 * 用法：
 *   node scripts/privacy-scan.mjs            # 扫当前仓库（已跟踪 + 未跟踪但没被忽略）
 *   node scripts/privacy-scan.mjs <目录>      # 扫指定目录
 *   node scripts/privacy-scan.mjs --staged   # 只扫已暂存的改动
 *
 * 退出码：0 = 干净；1 = 有命中（逐条打印 file:line 规则名）。
 *
 * ★ 这份脚本只认「形状」，不认具体值 —— 所以它自己可以进仓库。
 *   已知的假值（13800138000 / user@example.com / 138****8000 …）在 ALLOW 里放行，
 *   否则每个文档示例都会被它误报。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const staged = args.includes("--staged");
const root = path.resolve(args.find((a) => !a.startsWith("--")) ?? ".");

/** 明确安全的假值 / 占位符（判据：整串命中才算，不做模糊匹配） */
const ALLOW = [
  "13800138000", "13800000000", "13900000000", "18888888888", "13312345678",
  "138****8000", "123****4567", "138****8000", "199****0000",
  "user@example.com", "a@b.co", "test@example.com",
];

const RULES = [
  ["手机号（未打码）", /(?<![\d])(1[3-9]\d{9})(?![\d])/g],
  ["邮箱（非占位）", /(?<![\w.+-])([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g],
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g],
  ["API key", /\b(sk-[A-Za-z0-9_-]{24,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g],
  ["私钥", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["JWT", /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,})/g],
  ["内网 IP", /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g],
  ["本机用户目录", /[A-Za-z]:[\\/]{1,4}Users[\\/]{1,4}[A-Za-z0-9][^\s"'`)]*/g],
  ["密钥目录", /[A-Za-z]:[\\/]{1,4}(?:MyKey|Keys)[\\/]?/g],
  ["Cookie 值", /\b(?:set-)?cookie\s*[:=]\s*["'`][^"'`]{20,}/gi],
];

/** 这些邮箱/域名是文档示例或 GitHub 托管地址，不算泄露 */
const MAIL_OK = /@(?:users\.noreply\.github\.com|example\.(?:com|org)|localhost)$|^git@github\.com$|^(?:user|someone|test|you|name|me|foo|bar|a|b|1|2|x|y|abc|demo)@/i;
const IP_OK = /^(?:127\.|0\.0\.0\.0|10\.0\.0\.1|192\.0\.2\.)/;

const TEXT = /\.(md|mjs|js|cjs|ts|tsx|json|jsonc|yml|yaml|ps1|sh|txt|html|css|toml)$/i;
const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build)\//;

const files = (() => {
  try {
    if (staged) {
      return execFileSync("git", ["-C", root, "diff", "--cached", "--name-only", "--diff-filter=ACMR"], { encoding: "utf8" })
        .split("\n").filter(Boolean);
    }
    return execFileSync("git", ["-C", root, "-c", "core.quotepath=false", "ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
      .split("\n").filter(Boolean);
  } catch {
    // 不是 git 仓库：退化成遍历
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        const rel = path.relative(root, p).split(path.sep).join("/");
        if (e.isDirectory()) { if (!SKIP_DIR.test(rel + "/")) walk(p); continue; }
        out.push(rel);
      }
    };
    walk(root);
    return out;
  }
})();

let hits = 0;
for (const rel of files) {
  if (!TEXT.test(rel) || SKIP_DIR.test(rel)) continue;
  const full = path.join(root, rel);
  let src;
  try { src = fs.readFileSync(full, "utf8"); } catch { continue; }
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 4000) continue;
    for (const [name, re] of RULES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        const hit = m[1] ?? m[0];
        if (name === "手机号（未打码）" && ALLOW.includes(hit)) continue;
        if (name === "邮箱（非占位）" && (MAIL_OK.test(hit) || ALLOW.includes(hit))) continue;
        if (name === "内网 IP" && IP_OK.test(hit)) continue;
        if (name === "本机用户目录") {
          const seg = (hit.split(/Users[\\/]{1,2}/)[1] ?? "").split(/[\\/]/)[0];
          if (/^(?:<|\$|%|x|u|user|username|you|me|someone|placeholder)/i.test(seg)) continue;
        }
        if (name === "GitHub token" && /abcdefgh|123456|example/i.test(hit)) continue;
        console.log(`${rel}:${i + 1}  [${name}]  ${hit.length > 48 ? hit.slice(0, 44) + "…" : hit}`);
        hits++;
      }
    }
  }
}

if (hits) {
  console.error(`\nprivacy-scan: ${hits} 处待脱敏（见上）。改完再提交；已 push 过的还要重写历史。`);
  process.exit(1);
}
console.log("privacy-scan: PASS（0 处）");
