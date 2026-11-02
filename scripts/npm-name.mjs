#!/usr/bin/env node
// 打印这个仓库发布到 npm 时用的包名：
//   package.json.name（默认）或 publish-npm.mjs 的 PUBLISH_AS / NPM_NAME。
// release.yml 用它判断「这个版本是否已经在 npm 上」，避免 tag 触发的 CI
// 与本地 release.mjs --npm 重复发布同一版（409）。

import { existsSync, readFileSync } from "node:fs"

const pkg = JSON.parse(readFileSync("package.json", "utf8"))
let name = pkg.name
for (const file of ["scripts/publish-npm.mjs", "publish-npm.mjs"]) {
  if (!existsSync(file)) continue
  const m = readFileSync(file, "utf8").match(/(?:PUBLISH_AS|NPM_NAME)\s*=\s*["']([^"']+)["']/)
  if (m) {
    name = m[1]
    break
  }
}
process.stdout.write(name)
