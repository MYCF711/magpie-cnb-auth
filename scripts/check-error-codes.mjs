#!/usr/bin/env node
// 静态近似检查：插件的错误出口是否都带 status + code，且 code 在 ERROR-CODES.md §3 词表里。
//
//   node scripts/check-error-codes.mjs [插件目录] [--json]
//
// 抓的是**形态**，不是语义；语义最终靠人工评审（见 ERROR-CODES.md §8 验收清单）。
// 但形态错了，语义基本也错：一个 404 用在「不支持的端点」上，宿主就会去换模型。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// §3 词表（加码要改 ERROR-CODES.md 并升版本，这里同步）
const CODES = new Set([
  "sign_in_required",
  "session_expired",
  "audit_blocked",
  "invalid_request",
  "model_not_found",
  "concurrency_conflict",
  "rate_limited",
  "upstream_unavailable",
  "upstream_timeout",
  "upstream_error",
  "internal_error",
  "not_implemented",
]);

const MODELISH = /模型|model|ModelNotFound|reasoning|embedding/i;
const ENDPOINTISH = /端点|endpoint|不支持|unsupported|not_found|Not Found/i;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function targets(dir) {
  const out = [];
  const push = (p) => { if (fs.existsSync(p) && fs.statSync(p).isFile()) out.push(p); };
  push(path.join(dir, "index.mjs"));
  const src = path.join(dir, "src");
  if (fs.existsSync(src)) {
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".mjs")) out.push(p);
      }
    };
    walk(src);
  }
  return out;
}

// 从左括号位置找到配对的右括号（跳过字符串）
function matchParen(src, openIdx) {
  let depth = 0;
  let quote = "";
  for (let i = openIdx; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === "\\") { i += 1; continue; }
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitArgs(src, openIdx, closeIdx) {
  const args = [];
  let depth = 0;
  let quote = "";
  let start = openIdx + 1;
  for (let i = openIdx + 1; i < closeIdx; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === "\\") { i += 1; continue; }
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") depth -= 1;
    else if (c === "," && depth === 0) {
      args.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = src.slice(start, closeIdx).trim();
  if (tail) args.push(tail);
  return args;
}

function lineOf(src, idx) {
  return src.slice(0, idx).split("\n").length;
}

function lineText(src, lineNo) {
  return (src.split("\n")[lineNo - 1] || "").trim();
}

function nearestFn(src, idx) {
  const before = src.slice(0, idx);
  const hits = [...before.matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_$]+)|(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/g)];
  const last = hits[hits.length - 1];
  return last ? (last[1] || last[2]) : "(顶层)";
}

// 注释里的 404 / code 字样不算（「user/info 等全是 404」这种说明性文字）
function isCommentLine(src, idx) {
  const start = src.lastIndexOf("\n", idx) + 1;
  const line = src.slice(start, src.indexOf("\n", idx) === -1 ? src.length : src.indexOf("\n", idx)).trim();
  return line.startsWith("//") || line.startsWith("*") || line.startsWith("/*");
}

function checkFile(file, src) {
  const results = [];
  const rel = path.basename(file);

  // ── R1 / R2：errorResponse 的 code 参数 ─────────────────────────────
  const calls = [...src.matchAll(/\berrorResponse\s*\(/g)];
  let literalCodes = 0;
  for (const m of calls) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(src, open);
    if (close < 0) continue;
    const args = splitArgs(src, open, close);
    const ln = lineOf(src, m.index);
    if (args.length < 3) {
      results.push({
        rule: "R1", ok: false, file: rel, line: ln,
        message: `errorResponse 没有显式 code 参数（默认落 upstream_error）`,
      });
      continue;
    }
    const codeArg = args[2];
    const lit = codeArg.match(/^["'`]([a-z0-9_]+)["'`]$/);
    if (lit) {
      literalCodes += 1;
      if (!CODES.has(lit[1])) {
        results.push({
          rule: "R2", ok: false, file: rel, line: ln,
          message: `code "${lit[1]}" 不在词表里`,
        });
      }
    }
    // ── R4：只有「错误出口上的 404」才检查 ──────────────────────────
    // 本地回调服务器 reply(404) 之类不是 magpie 的 chat 通道，不在此列。
    const whole = args.join(" ");
    const ctx = src.split("\n").slice(ln - 2, ln + 2).join(" ");
    if (/\b404\b/.test(whole) && ENDPOINTISH.test(ctx) && !MODELISH.test(ctx)) {
      results.push({
        rule: "R4", ok: false, file: rel, line: ln,
        message: `404 用在「不支持的端点」上 —— 会被宿主当成模型不存在，应改为 501 + not_implemented`,
      });
    }
  }
  if (calls.length && literalCodes >= 0) {
    results.push({ rule: "R1", ok: true, file: rel, line: 0, message: `errorResponse 调用 ${calls.length} 处，均带 code 参数` });
  }

  // ── R2：其它形态的 code 字面量（跳过注释）───────────────────────
  for (const m of src.matchAll(/\bcode\s*:\s*["'`]([a-z0-9_]+)["'`]/g)) {
    if (isCommentLine(src, m.index)) continue;
    if (!CODES.has(m[1])) {
      results.push({
        rule: "R2", ok: false, file: rel, line: lineOf(src, m.index),
        message: `错误帧里的 code "${m[1]}" 不在词表里`,
      });
    }
  }

  // ── R6：SSE 错误帧必须带 status ────────────────────────────────────
  for (const m of src.matchAll(/type\s*:\s*["'`]upstream_error["'`]/g)) {
    const window = src.slice(m.index, m.index + 260);
    if (!/\bstatus\b/.test(window)) {
      results.push({
        rule: "R6", ok: false, file: rel, line: lineOf(src, m.index),
        message: `流式错误帧缺 status 字段（宿主拿不到判据）`,
      });
    }
  }

  // ── R8：超时类不许落 502 ───────────────────────────────────────────
  for (const m of src.matchAll(/\b(?:timeout|idle|deadline|wallclock)\b/gi)) {
    const ln = lineOf(src, m.index);
    const ctx = src.split("\n").slice(ln - 1, ln + 2).join(" ");
    if (/\b502\b/.test(ctx)) {
      results.push({
        rule: "R8", ok: false, file: rel, line: ln,
        message: `超时类错误落到 502 —— 应落 503/504（可重试）`,
      });
    }
  }

  // ── R3 提示：裸 throw new Error 的分布 ─────────────────────────────
  const naked = [...src.matchAll(/throw\s+new\s+Error\s*\(/g)];
  if (naked.length) {
    const fns = [...new Set(naked.map((m) => nearestFn(src, m.index)))];
    results.push({
      rule: "R3", ok: true, file: rel, line: 0,
      message: `裸 throw new Error ${naked.length} 处，分布在：${fns.slice(0, 8).join("、")}${fns.length > 8 ? "…" : ""}（逐个确认是否进聊天通道；进了就必须包成 upstreamError(msg, status)）`,
    });
  }

  return results;
}

// 供 scripts/check.mjs 集成调用（同一个扫描，不重复实现）
export function scanErrorCodes(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = targets(dir);
  if (!files.length) return [];
  const all = [];
  for (const file of files) all.push(...checkFile(file, fs.readFileSync(file, "utf8")));
  return all;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const dir = args.find((a) => !a.startsWith("--")) || ".";
  if (!fs.existsSync(dir)) fail(`目录不存在：${dir}`);

  const files = targets(dir);
  if (!files.length) fail(`在 ${dir} 里没找到 index.mjs 或 src/**/*.mjs`);

  const all = scanErrorCodes(dir);

  if (asJson) {
    console.log(JSON.stringify(all, null, 2));
  } else {
    const bad = all.filter((r) => !r.ok);
    for (const r of all.filter((x) => x.ok)) console.log(`  ✓ ${r.rule} ${r.message}`);
    for (const r of bad) console.log(`  ✗ ${r.rule} ${r.file}:${r.line} ${r.message}`);
    const rules = new Set(all.map((r) => r.rule));
    console.log(`\n  扫描 ${files.length} 个文件 · 规则 ${[...rules].sort().join("/")} · 失败 ${bad.length}`);
    if (!bad.length) console.log("  通过：错误出口都带 status + code，且 code 在词表内。");
  }

  process.exit(all.some((r) => !r.ok) ? 1 : 0);
}
