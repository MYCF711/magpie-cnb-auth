#!/usr/bin/env node
// 从一个已验证的模板起一个新插件 —— 不可变部分照抄，身份三处自动改掉。
//
//   npx --yes github:MYCF711/magpie-plugin-scaffold#v0.3.6 create \
//     --dir my-plugin --provider huawei --name "华为云 HUAWEI" --package huawei-auth \
//     --base https://api.huawei.example/v1
//
// 它做的事只有「复制 + 改身份」：
//   · 复制模板的全部源码、测试、文档、CI（跳过 .git / node_modules / 打包产物）
//   · package.json：name（显示名）/ version / description；加发布脚本 publish:npm
//   · index.mjs、src/context.mjs：PROVIDER / PROVIDER_NAME / BASE
//   · scripts/publish-npm.mjs：发布时把 name 换成 npm 包名
//   · registry-entry.json：package（npm 包名）/ name（显示名）/ providers
//   · 打印接下来要做的五件事
//
// 它**不做**：不联网、不装依赖、不改 magpie 的配置、不发布、不碰已有目录。
// 目标目录已存在且非空时直接失败，宁可让调用方自己决定，也不覆盖别人的东西。

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE_ROOT = resolve(HERE, "..")

const SKIP_DIRS = new Set([".git", "node_modules", "tmp"])
const SKIP_FILES = new Set([".DS_Store", "package-lock.json", "bun.lock", "bun.lockb"])

function usage(stream = process.stdout) {
  stream.write(
    [
      "用法：magpie-plugin create --dir <目录> --provider <id> --name <显示名> [--base <URL>] [--package <包名>]",
      "",
      "  --dir      必填，新插件目录（不存在，或存在但为空）",
      "  --provider 必填，magpie provider id，小写字母/数字/连字符",
      "  --name     必填，显示名 = <中文> <English>（magpie.name / provider / registry）",
      "             例：\"华为云 HUAWEI\"、\"码道 CodeArts\"、\"果办 OfficeAce\"",
      "  --base     上游 API 基址，默认 https://api.<provider>.example/v1",
      "  --package  npm 包名（小写 ASCII，不能带空格），默认 <provider>-auth",
      "",
    ].join("\n"),
  )
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const value = argv[i + 1]
    switch (key) {
      case "--dir":
      case "-d":
        out.dir = value
        i += 1
        break
      case "--provider":
      case "-p":
        out.provider = value
        i += 1
        break
      case "--name":
      case "-n":
        out.name = value
        i += 1
        break
      case "--base":
      case "-b":
        out.base = value
        i += 1
        break
      case "--package":
        out.package = value
        i += 1
        break
      case "--help":
      case "-h":
        out.help = true
        break
      default:
        throw new Error(`不认识这个参数：${key}`)
    }
  }
  return out
}

function fail(message) {
  process.stderr.write(`✗ ${message}\n`)
  process.exit(1)
}

function assertWritableDir(target) {
  if (!existsSync(target)) return
  if (!statSync(target).isDirectory()) fail(`目标已存在且不是目录：${target}`)
  const entries = readdirSync(target)
  if (entries.length > 0) {
    fail(`目标目录非空，不覆盖：${target}\n  先清空它，或换一个目录。这条规矩是为了不误删你已有的代码。`)
  }
}

function copyTemplate(target) {
  cpSync(TEMPLATE_ROOT, target, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter(source) {
      const name = basename(source)
      if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) return false
      if (name.endsWith(".tgz") || name.endsWith(".log")) return false
      return true
    },
  })
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function replaceConst(file, exportPrefix, provider, name, base) {
  const before = readFileSync(file, "utf8")
  const after = before
    .replace(new RegExp(`${exportPrefix}const PROVIDER = "[^"]*"`), `${exportPrefix}const PROVIDER = ${JSON.stringify(provider)}`)
    .replace(new RegExp(`${exportPrefix}const PROVIDER_NAME = "[^"]*"`), `${exportPrefix}const PROVIDER_NAME = ${JSON.stringify(name)}`)
    .replace(new RegExp(`${exportPrefix}const BASE = "[^"]*"`), `${exportPrefix}const BASE = ${JSON.stringify(base)}`)
  if (after === before) fail(`没能在 ${file} 里改掉身份常量 —— 模板结构变了，先修 create.mjs`)
  writeFileSync(file, after)
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    fail(e.message)
  }
  if (args.help) {
    usage()
    return
  }
  if (!args.dir) fail("缺少 --dir")
  if (!args.provider) fail("缺少 --provider")

  const provider = String(args.provider).trim()
  if (!/^[a-z0-9][a-z0-9-]*$/.test(provider)) {
    fail(`provider id 只能是小写字母、数字、连字符，且以字母/数字开头：${provider}`)
  }
  const name = String(args.name ?? "").trim()
  if (!name) fail('缺少 --name：显示名必须是 <中文> <English>，例如 "华为云 HUAWEI"')
  if (!/[\u3400-\u9fff]/.test(name) || !/[A-Za-z]/.test(name) || !/\s/.test(name)) {
    fail(`--name 必须是 <中文> <English>，中间一个空格；英文照抄厂商官方品牌写法：${name}`)
  }
  if (["未命名", "Unnamed", "TODO"].some((marker) => name.includes(marker))) {
    fail(`--name 不能保留占位符（未命名 / Unnamed / TODO）：${name}`)
  }
  const providerName = name
  const base = String(args.base ?? `https://api.${provider}.example/v1`).trim()
  const packageName = String(args.package ?? `${provider}-auth`).trim()
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(packageName)) {
    fail(`--package 必须是合法 npm 包名 / bun 依赖键（小写 ASCII，不能带空格）：${packageName}`)
  }

  const target = resolve(args.dir)
  if (target === resolve("/") || target === TEMPLATE_ROOT) fail(`目标目录不安全：${target}`)
  if (target.startsWith(TEMPLATE_ROOT + sep)) fail(`目标目录不能放在模板目录里面：${target}`)
  assertWritableDir(target)

  mkdirSync(target, { recursive: true })
  copyTemplate(target)

  // GitHub Template 复制的 ci.yml 仍带 template: "true"（给脚手架自己用的）；
  // 派生项目必须走严格模式，否则 action 自测会替占位符放行。
  const ciPath = join(target, ".github", "workflows", "ci.yml")
  if (existsSync(ciPath)) {
    writeFileSync(ciPath, readFileSync(ciPath, "utf8").replace(/template:\s*"true"/g, 'template: "false"'))
  }

  // ① package.json —— name 是 slug（bun 依赖键）；显示名进 magpie.name
  const pkgPath = join(target, "package.json")
  const pkg = readJson(pkgPath)
  pkg.name = packageName
  pkg.magpie = { ...(pkg.magpie ?? {}), name }
  pkg.version = "0.1.0"
  pkg.description = `A magpie / OpenCode provider plugin for ${providerName}.`
  delete pkg.repository
  delete pkg.bugs
  delete pkg.homepage
  delete pkg.bin
  pkg.keywords = [...new Set([...(Array.isArray(pkg.keywords) ? pkg.keywords : []), provider])]
  pkg.scripts = { ...(pkg.scripts ?? {}), "publish:npm": "node scripts/publish-npm.mjs" }
  delete pkg.scripts["check:template"]
  writeJson(pkgPath, pkg)

  // ①b 发布脚本：复用脚手架那份（含 CI 同版本幂等），只替换 PUBLISH_AS
  const publishPath = join(target, "scripts", "publish-npm.mjs")
  const publishSrc = readFileSync(publishPath, "utf8").replace(
    /const PUBLISH_AS = "[^"]*"/,
    `const PUBLISH_AS = ${JSON.stringify(packageName)}`,
  )
  writeFileSync(publishPath, publishSrc)

  // ② 三处身份常量（provider 显示名）
  replaceConst(join(target, "index.mjs"), "", provider, providerName, base)
  replaceConst(join(target, "src", "context.mjs"), "export ", provider, providerName, base)

  // ③ 请求头里那个模板占位名
  const indexPath = join(target, "index.mjs")
  const indexSource = readFileSync(indexPath, "utf8")
  writeFileSync(indexPath, indexSource.replaceAll("x-xxx-session", `x-${provider}-session`))

  // ④ 派生插件不需要模板自己的「采用路径」测试 —— 它测的是模板的 bin 与 Action
  rmSync(join(target, "tests", "adoption.test.mjs"), { force: true })

  // ⑤ CHANGELOG 换成派生插件自己的历史 —— 模板的历史留着会让首个 Release 抽错正文
  const today = new Date().toISOString().slice(0, 10)
  writeFileSync(
    join(target, "CHANGELOG.md"),
    [
      "# 更新记录",
      "",
      "> 每个版本一节，**一条一行**，说用户能感知的变化。",
      "> 格式与规矩见 [UPDATING.md](./UPDATING.md)。",
      "",
      `## 0.1.0 — ${today}`,
      "",
      "**初始版本**",
      "",
      `- 从 \`magpie-plugin-scaffold\` 生成，provider id = \`${provider}\``,
      "- 九个钩子齐全；五个 TODO 实现后逐个写进下一版",
      "",
    ].join("\n"),
  )

  // ⑥ registry 条目（收不收是维护者的事，先把形状填对）
  const registryPath = join(target, "registry-entry.json")
  if (existsSync(registryPath)) {
    writeJson(registryPath, {
      package: packageName,
      name: providerName,
      providers: [provider],
      summary: {
        en: `One sentence: what ${providerName} signs in to, and what the user gets.`,
        zh: `一句话：签入 ${providerName} 的什么服务，用户得到什么。`,
      },
    })
  }

  process.stdout.write(
    [
      "",
      `✓ 已生成 ${target}`,
      `  provider   ${provider}`,
      `  显示名     ${name}（magpie.name / provider / registry）`,
      `  包名       ${packageName}（bun 依赖键 / npm 名）`,
      `  基址       ${base}`,
      "",
      "接下来五件事（都在 GUIDE.md 里）：",
      "  1. 实现 index.mjs 底部的五个 TODO（startLoginFlow / exchangeRefresh / fetchUsage / doCheckin / fetchLiveModels）",
      "  2. 改 package.json 的 description 与 magpie.icon",
      "  3. 填 README.md（照 README-TEMPLATE.md）",
      "  4. 跑 node scripts/check.mjs，退出码必须是 0",
      "  5. 起分支 → PR 等 rules 绿 → 合并 → tag/Release（UPDATING.md）",
      "",
    ].join("\n"),
  )
}

main()
