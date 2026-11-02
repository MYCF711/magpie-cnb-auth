#!/usr/bin/env node
// 一个 bin，两个子命令 —— 这样 `npx github:...#tag check .` 能直接跑。
//
//   npx --yes github:MYCF711/magpie-plugin-scaffold#v0.3.6 check .
//   npx --yes github:MYCF711/magpie-plugin-scaffold#v0.3.6 create --dir ... --provider ... --name ...
//
// npm 的 npx 在一个包有多个 bin 时无法判断该跑哪个；所以对外只暴露 `magpie-plugin`。
// 子命令仍然各自是独立脚本，直接 `node scripts/check.mjs` / `node scripts/create.mjs` 也行。

import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const COMMANDS = {
  check: "check.mjs",
  create: "create.mjs",
}

function usage(stream = process.stdout) {
  stream.write(
    [
      "用法：magpie-plugin <check|create> [参数]",
      "",
      "  check  [目录]                 检查供应商插件，退出码 0 = 合规",
      "  create --dir <目录> --provider <id> --name <显示名>   从模板生成新插件",
      "",
      "示例：",
      "  npx --yes github:MYCF711/magpie-plugin-scaffold#v0.3.6 check .",
      '  npx --yes github:MYCF711/magpie-plugin-scaffold#v0.3.6 create --dir my-provider --provider huawei --name "华为云 HUAWEI"',
      "",
    ].join("\n"),
  )
}

const [command, ...args] = process.argv.slice(2)
if (!command || command === "--help" || command === "-h") {
  usage()
  process.exit(0)
}

const script = COMMANDS[command]
if (!script) {
  process.stderr.write(`✗ 不认识的子命令：${command}\n\n`)
  usage(process.stderr)
  process.exit(1)
}

const result = spawnSync(process.execPath, [join(HERE, script), ...args], { stdio: "inherit" })
if (result.error) {
  process.stderr.write(`✗ 启动 ${script} 失败：${result.error.message}\n`)
  process.exit(1)
}
process.exit(result.status ?? 1)