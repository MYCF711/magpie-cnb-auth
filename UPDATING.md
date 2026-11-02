# 更新途径

> 插件发出去之后：**怎么发下一个版本，用户怎么拿到它。**
> 首次发布（`npm publish` + 进市场）见 [README](./README.md) 的「怎么发布」——
> 这一份只管**之后每一次**。

## 铁律：默认分支只接受通过门禁的 PR

**不许直接 `git push origin main`，不许从没合并的功能分支打 tag / 发 npm。**
唯一路径是：功能分支 → 本地检查 → 推分支 → **提 PR** → `rules` 全绿 → 合并 → 从 `main` 发布。
**为什么 PR 不能省**：受保护分支硬性要求走 PR 通道 —— 实测直推报
`GH006: Protected branch update failed ... Changes must be made through a pull request`。
能省的是 **required approvals**（保持 0，自己就能合并），不是 PR 本身。

原因很直接：git 源用户会跟随默认分支 HEAD，npm 源用户会跟随 registry 新版本。
绕过 PR 直接把坏提交推上去，等于把故障分发给所有正在用的人。

这不是自己发明的流程。[GitHub 的 protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
用「必需 PR + 必需状态检查 + 分支必须最新 + 管理员同样受限」强制执行；
[release-please](https://github.com/googleapis/release-please) 进一步把版本号与 CHANGELOG 也做成 Release PR。
本仓库保留现有 `release.mjs`，不引入另一套机器人，但采用同一道门：**先审一个可验证的 PR，再发布合并结果。**

逐条勾 [CHECKLIST.md](./CHECKLIST.md) 的 B 表，别凭记忆。

---

## 一之前 · 分支和 `main` 各管什么（这条规矩的第一性理由）

**分支不是「先放着的未验证代码」，是「测试版本的发布通道」。**

这条规矩不是从「PR 流程」倒推出来的，是从一个很具体的问题来的：
**怕把别人正在用的插件炸了。** git 源的用户跟随**默认分支 HEAD**，
所以坏提交一旦进 `main`，所有人下一次检查更新就会拿到。

解法不是「晚点推」，是**推分支**：

| 通道 | 写在哪 | 用户怎么装 | 谁拿得到 |
|---|---|---|---|
| **稳定版** | 默认分支 `main` | `magpie plugin add github:owner/repo` | 所有人；git 源会提示更新 |
| **测试版** | 任意分支 | `magpie plugin add github:owner/repo#feat-x` | **只有显式写 `#ref` 的人**；同样会提示该分支的新 commit |

官方契约（`usemagpie.ai/docs/plugins#run`）：git 仓库按 `github:owner/repo[#ref]` 拉取；
更新检测比的是「它的分支或标签（不写 `#ref` 时是默认分支）指向的提交和装的那个」。
⇒ **分支是给愿意试的人用的，`main` 是给所有人用的**，两条通道互不影响。

**PR 则是 GitHub 对受保护分支的技术要求** —— 实测直推会被拒：

```
remote: error: GH006: Protected branch update failed for refs/heads/main.
remote: - Changes must be made through a pull request.
```

它不是这条规矩的目的，只是把「测试版」与「稳定版」隔开的那道闸。
批准数保持 **0**，自己就能合，不需要找人看。

---

## 一、先搞清楚 magpie 怎么发现「有新版本」

**两条路，机制不一样。** 搞错了就是「我明明发了，用户那边没动静」。

| | npm 源 | git 源 |
|---|---|---|
| 装法 | `magpie plugin add <包名>` | `magpie plugin add github:owner/repo` |
| magpie 比什么 | npm registry 上的 **`version`** | 默认分支 HEAD 的 **commit** |
| 怎么拿 | npm registry | `https://api.github.com` + `git/ref/heads/<默认分支>` |
| 之后会怎样 | **自动更新** | 只**提示**，要用户手动更新 |
| 证据落在哪 | `~/.config/magpie/plugin-updates.json` 的 `updated[]` | 界面文案「N plugins have updates」|

实测（2026-10-26）：`plugin-updates.json` 里 9 条记录**全是 npm 包**，
两个 git 源插件一条都没有 —— git 源没有版本号可比，magpie 比的是 commit。

⇒ 两条硬推论：

1. **git 源最终必须落到默认分支（`main`），而且只能经 PR 合并。** 功能分支本身不会触发用户更新。
2. **npm 源必须 bump `version` 再 `npm publish`。** 不 bump 就检测不到；发布输入必须是 PR 合并后的提交。

> **只走 git 源也可以。** 不发 npm 的插件，就只有「PR 合进默认分支」这半条路 ——
> npm 那张表不适用。少一个发布口，少一处出错。

---

## 二、发一个版本：照这个顺序

### 第 0 步 · 从最新默认分支起功能分支

```bash
git switch main
git pull --ff-only origin main
git switch -c feat/<这次改动>
```

**直接停在 `main` 上提交也不行。** 一旦养成这个习惯，下一步就会变回直接推坏包。

### 第 1 步 · 写 CHANGELOG + bump `version`

见下面的「四、更新内容怎么写」。**不是发完再补**。

```bash
npm version patch --no-git-tag-version     # 0.1.7 → 0.1.8；minor/major 同理
```

⚠ 改名分两种，别混：
- **显示名**（`<中文> <English>`，可带空格）：`package.json.magpie.name`、provider 的 `name`、`registry-entry.json.name`；
- **包名 / npm 名**（slug，无空格）：`package.json.name`、`publish:npm` 脚本里的 `PUBLISH_AS`、`registry-entry.json.package`、README 安装命令。

### 第 2 步 · 本地检查，测试不是可选项

```bash
node scripts/check.mjs       # 派生仓库若没有自己的，就跑脚手架那份并指向当前仓库
npm test                     # 没有 test 脚本时，运行仓库实际的 tests/*.test.mjs / smoke 测试
npm pack --dry-run           # README、CHANGELOG、docs 都在包里吗
```

⚠ 模板默认的 `name = "unnamed-plugin"` / `magpie.name = "⚠ 未命名插件 Unnamed Plugin"` /
`⚠ 未命名供应商 Unnamed Provider` 不改，`check.mjs` 会退出 1 并打印
「magpie.name 不是占位符」。`--template` 只给脚手架自身用，派生项目不要加。

任何一条失败就留在功能分支修，**不许靠 `|| true` 把红色检查抹成绿色**。

### 第 3 步 · 提交并推功能分支

一条 commit 一件事，message 用 `<范围>: <小写句子>`：

```bash
git add -A
git commit -m "models: correct the measured context window"
git push -u origin feat/<这次改动>
```

### 第 4 步 · PR 全绿后合并

```bash
gh pr create --base main --fill
gh pr checks --watch
# 确认检查全绿之后，再在 GitHub 上合并（或 gh pr merge --squash）
```

合并前必须同时满足：PR 指向默认分支、必需检查 `rules` 成功、分支已跟上最新默认分支、讨论已解决。
**本地测试绿不替代 PR 检查绿。** 合并后用户才能看到新的默认分支 HEAD。

仓库设置必须是：

| 设置 | 值 |
|---|---|
| Require a pull request before merging | **必须开**。API 里 `required_pull_request_reviews` 为 `null` = 不要求 PR；为对象（哪怕 `required_approving_review_count = 0`）= **要求 PR 但不需要批准**。实测（2026-10-30）：分支的 `rules` 已绿、直接 `git push origin <branch>:main` 仍被拒 —— `GH006: Changes must be made through a pull request` |
| Require status checks to pass | 开，必需检查 = `rules` |
| Require branches to be up to date | 开 |
| Require conversation resolution | 开 |
| Do not allow bypassing settings / enforce admins | 开 |
| Force pushes / deletions | 都关 |

### 第 5 步 · 回到已合并的默认分支，再发 npm

```bash
git switch main
git pull --ff-only origin main
node scripts/release.mjs              # 预演；HEAD 必须和 origin/main 完全一致
node scripts/release.mjs --yes --npm  # 真做；有 publish:npm 脚本会自动用它
```

`release.mjs` **不再执行 `git push origin main`**。本地领先远端一个提交都会拒绝；
它还会在任何远端副作用之前重跑合规检查、测试和 `npm pack --dry-run`。

⚠ 同版本号重复 publish 会被拒；改了代码必须 bump。
⚠ npm 名与 `package.json.name` 不同时，一律走 `npm run publish:npm`；裸 `npm publish` 会被 registry 拒（或发错名）。
`publish:npm` 失败时脚本会还原 `package.json.name`，并提示「版本已存在就 bump」。

#### NPM_TOKEN：CI 发布不能假绿

`release.yml` 的 npm 步骤用 `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`。没配 secret 时
**0.3.0 起会显式失败**（之前是 `exit 0` 跳过，日志绿但 npm 上什么都没发 —— 假绿）：

```
::error title=NPM_TOKEN 未配置::在仓库 Settings → Secrets and variables → Actions 加 NPM_TOKEN
```

配置步骤：

1. 登录 [npmjs.com](https://www.npmjs.com/) → 头像 → **Access Tokens** → Generate New Token
   （选 **Automation** 或 Classic 的 publish 权限；只给这个仓库用，别复用个人 token）。
2. GitHub 仓库 → **Settings → Secrets and variables → Actions → New repository secret**
   → Name 填 `NPM_TOKEN`，Value 粘 token。
3. 推 tag / 手动跑 `release.yml`，npm 步骤必须真的看到 `+ <包名>@<版本>`。

没有 `NPM_TOKEN` 时：git 源与 GitHub Release 仍可走，但 **npm 步骤失败**，不要把它当成功。

**已经手工发过之后重跑 workflow 是安全的**：npm 步骤先查 `npm view <pkg>@<version> version`；
已存在就 `already published, skipping` + `exit 0`（保持绿），不会再因 E409 变红。
`node scripts/release.mjs --npm` 也有同一守卫：已存在时跳过 npm，tag/Release 继续。

### 第 6 步 · tag + GitHub Release

**这一步是给人看的，不是给 magpie 看的**，但用户需要它确认「这一版改了什么」。

| 路 | 怎么做 | 适合 |
|---|---|---|
| **`node scripts/release.mjs --yes [--npm]`** | 校验已合并 HEAD、版本、CHANGELOG、干净工作区、检查与测试、tag 未占用 → 只推 tag → 建 Release | 默认 |
| 有 `release.yml` | 推 `v*` tag；workflow 再验一次「tag 对应版本、提交已进默认分支、测试与 pack 全绿」 | CI 长期接管 |
| 手工 | 网页 Draft a new release，正文把 CHANGELOG 那段粘过去 | 一次性仓库；仍只能选已合并提交 |

它**故意不帮你做**第 0~4 步：分支、PR 和合并必须先在 GitHub 上完成。

#### workflow 是发布门禁，不只是省事工具

仍在维护的仓库默认带 `ci.yml` 与 `release.yml`：前者拦 PR，后者拦不符合发布条件的 tag。
只有明确归档、不再向用户分发的仓库才不必补。

#### 有 workflow 的话：推个 tag 就完事

本模板带了 [`.github/workflows/release.yml`](./.github/workflows/release.yml)。
推一个 `v*` tag 后，它先验证：tag 与 `package.json` 版本一致、tag 提交是默认分支祖先、
合规检查 / 语义测试 / pack 预演全过。任一不符就停止，**不会建 Release，也不会发 npm**。
全部通过后才从 `CHANGELOG.md` 抽正文建 Release。

```bash
git tag v0.1.8 && git push origin v0.1.8
```

⚠ workflow **不会替你合并 PR 或推默认分支**。配置了 `NPM_TOKEN` 时它会在 Release 成功后发 npm；
没配置则明确跳过 npm，git 源与 Release 不受影响。需要免长期 token 时，可按
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) 绑定这个 `release.yml` 与 OIDC。

⚠⚠ **别用「删 tag 再重推」来刷新正文。** 删 tag 并不会删掉 Release —— GitHub 把它
**转成草稿（`draft: true`）**。草稿在网页和匿名 API 上都看不见（`releases/tags/<tag>` 直接
404），只有带 token 的 `releases` 列表能看到它；表现得很像「Release 没了」，其实还在。
想刷新已发版本的正文，去 **Actions 页面手动跑一次 `release`**（workflow 带
`workflow_dispatch`，填 tag 即可），或者干脆改 `CHANGELOG.md` 发下一个版本。

⚠ 如果 Release 已经躺在草稿态（上面那个坑），发出去：

```bash
gh release edit v0.1.8 --draft=false
```

本模板的 workflow 已经在 edit 分支带上 `--draft=false`，不会再把草稿留在草稿态。

#### 没有 workflow 的话：手工发

打开 `https://github.com/<owner>/<repo>/releases/new`：

| 字段 | 填什么 |
|---|---|
| Choose a tag | `v0.1.8` —— 新建，和 `package.json` 的 `version` 一致，前面加 `v` |
| Target | 默认分支 |
| Release title | `0.1.8`（或一句话概括这次最要紧的那条）|
| Describe this release | **把 CHANGELOG 里这个版本那几条原样粘过来，一条一行** |

命令行等价（`gh` 已登录时）：

```bash
sed -n '/^## 0.1.8/,/^## 0.1.7/p' CHANGELOG.md | sed '$d' > /tmp/notes.md
gh release create v0.1.8 --title 0.1.8 --notes-file /tmp/notes.md
```

⚠ **Release / tag 不参与 magpie 的更新检测。** 实测：git 源比的是**默认分支 HEAD 的
commit**，npm 源比的是 registry 上的 **`version`** —— 两条路都不看 Release 和 tag。
所以「发了 Release 就算发布完了」是错的：**push 和 publish 一个都不能少。**

Release 的价值在另外三处：

1. 用户点进去就能读「这个版本改了什么」（一条条），不用去翻 commit log
2. tag 让「某个 bug 出在哪个版本」有据可查
3. GitHub 会自动附上该 tag 的源码包

### 第 7 步 · 验证（五条都要过）

```bash
# ⓪ 维护状态：改了代码必须 bump、bump 了必须有 tag、CHANGELOG 必须有这一节
node scripts/check-maintenance.mjs      # 退出码非 0 就别发布

# ① npm 上是不是新版本（发布后可能要等一两分钟才可见）
npm view <包名> version

# ② 线上 tarball 里确实是新内容 —— 别只看版本号
url=$(npm view <包名>@<新版本> dist.tarball)
curl -s "$url" | tar -xzOf - package/CHANGELOG.md | head -20

# ③ 本机 magpie 认得
magpie plugin list | grep -A1 <名>

# ④ Release 在（tag 与 version 一致）
gh release view v<新版本> --json tagName,url
```

> **第 ⓪ 条是这一节唯一能自动化的一步**，也是唯一能查出「直接覆盖仓库不发新版本」的一步。
> 它抓四种静默失配：改了代码没 bump、bump 了没 tag、CHANGELOG 没这一节、跳版本发。
> 四种都不会报错，只是用户永远拿不到新版。

---

## 三、用户侧：怎么拿到更新

### npm 装的人

不用管 —— magpie 自己会更新（`KeepUpdated`），结果记在
`~/.config/magpie/plugin-updates.json` 的 `updated[]` 里（`from` / `to` / `at`）。

想手动催一次：

```bash
magpie plugin update          # 装每个插件的最新版
```

### git 装的人

magpie 只会**提示**，要用户手动更新：

```bash
magpie plugin update
```

**想试测试版本（分支）**：装的时候把分支写进去，之后就跟这个分支走：

```bash
magpie plugin add github:owner/repo#feat-x   # 只影响你这一个装法
magpie plugin update                          # 分支有新 commit 时，这里会提示
```

分支和 `main` 是两条互不影响的通道 —— 分支上怎么折腾都不会影响用 `main` 的人。
反过来说：**你在分支上推的东西，没写 `#ref` 的人永远拿不到**，所以别指望它「先让大家试试」。

⚠ 若版本没动，是 `bun.lock` 锁住了旧 commit —— 这时**单跑 `plugin add` 也没用**
（实测：它会打印 `✓ added`，版本却不变）。先移除再装，才会重新解析：

```bash
magpie plugin rm <插件名>
magpie plugin add github:owner/repo
```

⚠⚠ **`rm` + `add` 会把 `plugins/package.json` 的依赖键改回包名** ——
而那个键**就是卡片上显示的名字**（见 README「常见坑 7」）。
手改回来可以，但下次 `add` / `update` 又会重置；**要永久改名只能改包内
`package.json` 的 `name`**（那会影响 npm 发布名）。

⚠ **别自己去跑 `~/.cache/magpie/bun/*/magpie-bun.exe`** —— magpie 调 bun 时会
自备 CA 环境，裸跑会报 `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`（而且 exit code 是 0，
看不出来）。一律走 `magpie plugin ...`。

### 卡片标题：`magpie.name`；依赖键仍是 slug

**卡片标题不再依赖添加方式。** magpie 的 `shownName()`
（`internal/gui/assets/plugins.js:1120`）优先级：

```
社区 registry 名 → package.json 的 magpie.name → bun 依赖键 → spec
```

所以显示名写进 `package.json.magpie.name`，`package.json.name` 只做 slug：

```json
{
  "name": "huawei",
  "magpie": { "name": "华为云 HUAWEI" }
}
```

| 位置 | 放什么 | 例 |
|---|---|---|
| `package.json.name` | bun 依赖键 / npm 名（slug，无空格） | `huawei`、`codearts-auth` |
| `package.json.magpie.name` | 卡片标题（中文 + English，可带空格） | `华为云 HUAWEI` |
| provider 的 `name` | 供应商列表显示名 | `华为云 HUAWEI` |
| `registry-entry.json.name` | 市场条目显示名 | `果办 OfficeAce` |

⚠⚠ **为什么 `name` 不能有空格（实测）**：bun 用包内 `name` 写
`~/.config/magpie/plugins/package.json` 的依赖键；`magpie plugin update` 对 git 插件的
`reinstall()` 会把依赖键当包 spec 传给 `bun update`。键里有空格时 bun 直接报：

```
unrecognised dependency format: 华为云 HUAWEI
```

结果不是「标题不好看」，是**整个 `magpie plugin update` 失败**。把显示名放进 `magpie.name`
后，依赖键保持 slug，update 恢复正常。

⚠ **bun 只吃 ASCII 键**：中文键**即使没有空格**也会报同样的
`unrecognised dependency format`（实测 bun 1.4.4）。所以 `name` 必须是 ASCII slug，
这不是风格偏好，是硬约束。

⚠ **npm 不允许新包名含中文 / 大写**（npm 官方校验库逐字：
`name can no longer contain capital letters`，`validForNewPackages: false`）。
`package.json.name` 用 slug，npm 名由 `publish:npm` 注入。
模板默认 `name = "unnamed-plugin"`、`magpie.name = "⚠ 未命名插件 Unnamed Plugin"` /
provider `⚠ 未命名供应商 Unnamed Provider`；不改就会在 `check.mjs` 里失败。

#### 旧版带空格依赖键：迁移步骤

2026-10-31 之前按「`name` 里写中文+空格」装出去的插件，依赖键里已经有空格，
`magpie plugin update` 会失败。**不需要 `rm` + `add`，登录态不丢**；手工把键改成 slug，
再让新版本带 `magpie.name`：

```bash
cd ~/.config/magpie/plugins

# 1. 插件仓库：package.json
#    "name": "huawei"                 ← slug
#    "magpie": { "name": "华为云 HUAWEI" }  ← 显示名
#    发新版本后，用户 update 会用 slug 当依赖键

# 2. 本机依赖键：package.json 与 bun.lock 都改（bun.lock 两处：
#    workspaces.dependencies 和 packages），旧键 → slug

# 3. node_modules 目录名同步
mv "node_modules/华为云 HUAWEI" "node_modules/huawei"

# 4. 校验依赖图（不联网，只读缓存）
~/.cache/magpie/bun/1.4.4/magpie-bun.exe install --offline

# 5. 重启 magpie，再跑 magpie plugin update
```

如果手工改键太麻烦，也可以 `magpie plugin rm "旧名"` + `magpie plugin add github:owner/repo`，
但会丢该插件的登录态；能改键就优先改键。改完后 `plugin update` 不会再报
`unrecognised dependency format`，标题由 `magpie.name` 提供。

#### 包名与卡片标题不同怎么办：发布时由 `publish:npm` 注入

两个来源读的是**同一个** `package.json`：

| 谁读 | 读哪份 | 决定了什么 |
|---|---|---|
| bun（`plugin add github:…`）| 仓库里的 `package.json` | 依赖键 → **卡片标题（显示名）** |
| `npm publish` | **同一份** | npm 上的**包名** |

一个文件喂两个地方，所以想「git 装显示 `果办 OfficeAce`，npm 上仍是 `officeace-auth`」，
只能在**发布那一下**换掉 `name`：

```js
// scripts/publish-npm.mjs —— 用 `npm run publish:npm` 跑
import { execSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

const PUBLISH_AS = "officeace-auth"            // npm 包名：小写 ASCII、不变
const file = new URL("../package.json", import.meta.url)
const original = readFileSync(file, "utf8")
const pkg = JSON.parse(original)

pkg.name = PUBLISH_AS
writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n")
try {
  execSync("npm publish --access public", { stdio: "inherit" })
} finally {
  writeFileSync(file, original)                 // 无论成败都改回来
}
```

```jsonc
// package.json
"name": "officeace-auth",                     // slug（bun 依赖键 / npm 名）
  "magpie": { "name": "果办 OfficeAce" },       // 卡片标题（中文 + English）
"scripts": { "publish:npm": "node scripts/publish-npm.mjs" }
```

`registry-entry.json` 的两个名字要分开：

```jsonc
{
  "package": "officeace-auth",                 // npm 包名（不是显示名）
  "name": "果办 OfficeAce",                    // 市场里的显示名
  "providers": ["officeace"],
  "summary": { "en": "...", "zh": "..." }
}
```

**机制实测**（2026-10-26，officeace 与 loomy 各一次）：把 `name` 改成当时的显示名
`OfficeAce` 后，`magpie plugin rm OfficeAce` + `plugin add github:MYCF711/magpie-officeace`，
**全程不碰任何文件** —— 装出来的依赖键就是

```jsonc
"OfficeAce": "github:MYCF711/magpie-officeace"
```

`bun.lock` 里也跟着变成 `"OfficeAce": ["OfficeAce@github:…#<sha>", …]`（值首段 = 包名）。
新约定只是把显示名从 `OfficeAce` 换成 `果办 OfficeAce`（放 `magpie.name`），依赖键仍是 slug，机制不变。

⚠ 从此**不要裸跑 `npm publish`** —— 那会拿含中文/大写的显示名去发，而 registry 拒绝
**新**包名（不会静默变小写/转拼音）。一律用 `npm run publish:npm`。

⚠ 两个来源的依赖键从此不同：npm 装的是 `officeace-auth`（标题就是包名），
git 装的标题是 `果办 OfficeAce`（`magpie.name`），依赖键是 `officeace-auth`。**这正是「分开」的含义**，不是 bug。
好处是 npm 那边的包名没变 —— 已装用户照旧收到更新，不用重装。

#### 已经发出去了、又不想换包名

> 这一段是**旧版纯英文显示名**（`OfficeAce`）的实际操作记录；新约定下显示名写成
> `果办 OfficeAce`，三处同步的原则不变，把示例里的名字换成你的显示名即可。
> 优先的做法仍然是改仓库里的 `name` 后重新安装，不要长期手改用户缓存。

那只能在用户那边手改依赖键（三处同步），并且**每次 `add` / `update` 后都要改回来** ——
bun 会按包内 `name` 重写它。

```jsonc
// ~/.config/magpie/plugins/package.json
"dependencies": {
  "OfficeAce": "github:MYCF711/magpie-officeace",   // 不是 "officeace-auth"
  "Loomy":     "github:MYCF711/magpie-loomy-auth"   // 不是 "magpie-plugin-loomy-auth"
}
```

**为什么是依赖键**：magpie 没有 `displayName`，git 安装的卡片标题由
`plugin.Name()` → `gitName()` 反查 dependencies 的**键名**得来（源码见
[HOOKS.md](./HOOKS.md) 的「九之二、插件名」）。这个键同时是 `node_modules` 下的目录名。

改一处不够，**三处必须同步**：

| # | 位置 | 改什么 |
|---|---|---|
| 1 | `plugins/package.json` | `dependencies` 的键 |
| 2 | `plugins/bun.lock` | 两处键：`workspaces.dependencies` 与 `packages` |
| 3 | `plugins/node_modules/` | 目录 `旧名` → `新名` |

```bash
cd ~/.config/magpie/plugins
# 1、2 用编辑器的批量替换；3 用 mv —— 然后重启 magpie
mv node_modules/officeace-auth node_modules/OfficeAce
```

⚠ 漏掉第 3 步会报：`no such plugin: ...\plugins\node_modules\OfficeAce`。
⚠ `bun.lock` 的 `packages` 段里**键是依赖键、值的第一段是包自己的 `name`** —— 只改键：

```
"OfficeAce": ["officeace-auth@github:MYCF711/magpie-officeace#<sha>", ...]
   ↑ 改成这个            ↑ 这个不动（它是 npm 包名）
```

（把包内 `name` 改成 `OfficeAce` 之后两者会一致，就不存在这个问题了 —— 见上一节。）

> 为什么值得争这个标题：卡片标题是用户唯一看到的名字。`officeace-auth` 是包名，
> `果办 OfficeAce` 才是他装的那个服务。

---

## 四、更新内容怎么写

放 **`CHANGELOG.md`**，每个版本一节，**一条一行**。

```markdown
# 更新记录

## 0.1.8 — 2026-10-26

- **模型数纠错** —— README 与市场文案写「26 个」，实际界面只显示 7 个（平台目录 vs 计费清单）
- **README 重写** —— 按 magpie-plugin-scaffold 的九段结构；协议细节移入 `docs/internals.md`
- 删掉「跟随代理」一条 —— 包内没有代理代码
- ⚠ **破坏性**：`xxx` 配置项改名，老配置需手动迁移

## 0.1.7 — 2026-10-25

- 不再列出注册表里回 404 的模型 id
```

### 规矩

| 要 | 不要 |
|---|---|
| 一条一行，动词开头 | 一大段散文 |
| 说**用户能感知的变化**（界面、行为、数字） | 「优化了代码」「修复了一些问题」 |
| 带数字、带文件名 | 「若干改进」 |
| 新版本在最上面（倒序） | 正序追加 |
| 破坏性变更单独标 `⚠ **破坏性**` | 埋在中间让人自己发现 |
| 数字写清口径 | 换个版本就没人知道怎么复现的数 |

### 一个小节收尾用 `> 起因：`

这个仓库和四个真实插件里，事后最有用的一句话都是那行 `> 起因`：

```markdown
## 0.1.9 — 2026-10-27

- 删掉 `src/self-register.mjs` —— ……

> 起因：OfficeAce 那份 PR 的 review。结论是插件对 magpie 的目录**只有读的份**。
```

一条一行说的是**改了什么**；`> 起因` 说的是**为什么**。三个月后回来找「这条规矩
是哪来的、能不能改」，只有后半句能回答。**用户感知不到它，所以它不进 Release 正文。**

### 放在哪

| 载体 | 作用 |
|---|---|
| `CHANGELOG.md` | **主记录**，全历史，写在仓库里。`package.json` 的 `files` 要带上它 |
| GitHub Release | **发版动作本身**：tag `v<version>` + 正文放这次那几条（与 CHANGELOG 同源，一条一行）|
| README 末尾一行 | `> 更新记录：[CHANGELOG.md](./CHANGELOG.md)` —— 卡片正文就是 README，这是用户唯一看得见的路标 |

⚠ **magpie 的卡片只渲染 README**，不渲染别的文件。所以更新内容本身放 CHANGELOG，
README 里只留路标 —— 别把 changelog 抄一遍进 README，那是两份会打架的记录。

⚠ **Release 正文里的相对链接点不开。** `[CHANGELOG.md](./CHANGELOG.md)` 在 Release
页面上会相对 `/releases/...` 去解析 —— 正文里要么写全 URL，要么只写文件名。
（CHANGELOG 自己内部留相对链接没问题，那是仓库里的文件。）

---

## 五、发版前检查清单

```
□ 从最新 main 起了功能分支，没有在 main 上直接提交 / 推送
□ CHANGELOG 里这个版本那几条写好了（一条一行，说人话）
□ version 已经 bump（npm 源检测就看它）
□ 合规检查、语义测试、npm pack --dry-run 全过，没有用 || true 掩盖失败
□ 推的是功能分支，PR 的 `rules` 全绿后才合并进默认分支
□ 本地 main 与 origin/main 完全一致，release.mjs 预演通过
□ npm publish 成功（npm 名与 `package.json.name` 不同时用 `npm run publish:npm`）
□ GitHub Release 发了：tag `v<version>`，说明里一条条列了这次的更新
□ npm view <包名> version 已是新版本
□ 线上 tarball 抓下来看过（不只是版本号）
□ 如果是破坏性变更，CHANGELOG 里标了，README 里也提了
```

---

## 六、这套规矩是怎么来的

不是推测，是实测（2026-10-26，magpie 0.1.1254）：

| 结论 | 证据 |
|---|---|
| npm 源比 version、git 源比 HEAD commit | magpie 二进制里的符号 `plugin.GitHeads` / `GitHeadCached`、常量串 `api.github.com` + `git/ref/heads/`、界面文案 `"{n} plugins have updates"` |
| npm 源能自动更新，git 源只提示 | `~/.config/magpie/plugin-updates.json` 的 `updated[]` 里只有 npm 包 |
| `plugin add` 不会更新 git 源的锁 | lock 里 commit 停在旧的，命令照样打印 `✓ added` |
| `rm` + `add` 会更新（并重置依赖键） | lock 的 commit 从旧值变成新值；依赖键从别名退回包名 |
| 裸跑 bun 会因证书失败 | `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`；magpie 二进制里有 `plugin.caEnv` / `writeCAFile` / `systemRoots` |
| **Release / tag 不参与检测** | 二进制里 `/releases/tag/` 只出现在 magpie **自身**的下载地址（`yetone/magpie-releases`）；插件的两条检测路径分别是 `api.github.com` + `git/ref/heads/` 与 npm registry |

⚠ **未实测**：`magpie plugin update` 对 git 源插件的具体行为（没构造出「本地落后于
main」的状态）。上面写的是它该有的语义。

---

## 七、magpie 自己升级了，什么时候该动这些文档

**看稳定渠道，不看每版本渠道。** magpie 设置里有「更新渠道：每个版本 / 稳定版」——
用户默认跑后者，插件契约要跟的也是后者。

```bash
curl -s "https://usemagpie.ai/api/latest?channel=stable"   # {"version":"0.1.1327",…,"channel":"stable"}
curl -s "https://usemagpie.ai/api/latest"                  # 每版本：同一时刻可能是 0.1.1763
```

实测（2026-10-28）：两档差 **400 多个版本**（每版本 0.1.1763 / 稳定版 0.1.1327），
但把两边的内嵌契约都提取出来逐字段比对后 —— **插件相关的字段一条不差**。
多出来的两段（`summaries` / `last seen`）是 GUI 历史，不是插件契约。

⇒ 追每版本几乎全是白跑。判据只有一条：**稳定版版本号变了**。

```bash
node scripts/check-magpie-stable.mjs
#   0 = 基线（HOOKS.md 顶部那行「当前基线：x.y.z」）就是当前稳定版，不用动
#   2 = 稳定版变了，按它打印的三步走：下稳定版 → 提取 → contract-diff
```

稳定版变了之后的三步：

1. `curl -sL -o /tmp/magpie-<v>.exe https://github.com/yetone/magpie-releases/releases/download/v<v>/magpie-windows-amd64.exe`
2. `python extract-contract.py /tmp/magpie-<v>.exe`
3. `node scripts/contract-diff.mjs` → 差集里挑「不写会关掉某个能力」的补进 HOOKS

⚠ **内嵌契约抓不到的部分**（插件供图的 `DrawsID` / `ImagesAPI`、各类 ID 白名单）
在 Go 源码与 `docs/subsystems/*.md` 里，那部分只能读 release notes 与源码。
