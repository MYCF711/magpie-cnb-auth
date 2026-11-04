# CHECKLIST —— 两张表，两个交付门

> `scripts/check.mjs` 只查**能自动查的那部分**（约 30 条）。下面这些查不到，
> 但漏了照样出事，而且通常**不报错**。
>
> 用法：逐条勾，勾不上就是还没好。表格里的「判据」都能当场验，不用凭印象。

---

## A 表 · 代码交付前

给用户能装之前过一遍。

```
□ 1. config.models 有内容
      判据：插件装上后模型列表不是空的；静态占位也算
      出处：README 铁律 1

□ 2. authorize() 立刻返回
      判据：登录时不出现长时间转圈；所有网络请求都在 loader 里
      出处：README 铁律 2

□ 3. refresh 返回的是「合并」
      判据：刷新后原有字段一个不少（把旧对象展开再覆盖新字段）
      出处：README 铁律 3

□ 4. usage.used 是有限数字
      判据：额度条不是永远 100%；Number.isFinite(used) 为真
      出处：HOOKS 九

□ 5. free 来自厂商声明，不是从 rate 反推
      判据：rate===0 但套餐内收费的模型，没有被标 free
      出处：HOOKS 十一之二

□ 6. 模型级错误用 404
      判据：grep 一下 401/403 都用在了「登录失效」上，模型错误没有误用
      出处：README 常见坑 2

□ 7. 一次性 refresh_token 是串行的
      判据：同账号并发刷新有锁 / 复用同一个 in-flight promise
      出处：README 常见坑 4

□ 8. 上下文窗口是实测值，不是猜的
      判据：填错了会让 agent 认为「放不下」而拒绝长输入，见 README「上下文窗口要实测」
      出处：README 该节（含两种填错的后果）

□ 9. LICENSE 是逐字 MIT 正文，归属说明在 NOTICE.md
      判据：GitHub 仓库首页显示「MIT license」，不是 NOASSERTION
      出处：README 顶部四件

□ 10. 五个 TODO 的语义按 HOOKS.md 对过，不是「能跑就算」
      判据：每个钩子的返回值形状与 HOOKS 第 21 章一致
      出处：HOOKS 全章

□ 11. README 按 README-TEMPLATE.md 的九段结构写
      判据：开头有数字、功能一条一条、安装放最后、技术细节进了 docs/internals.md
      出处：README-TEMPLATE.md

□ 12. 有破坏性变更的话，CHANGELOG 里标了 ⚠ **破坏性**，README 里也提了
      判据：用户能从 CHANGELOG 一眼看出需要手动迁移什么
      出处：UPDATING 四

□ 13. node scripts/check.mjs 退出码 = 0
      判据：末尾「失败 0」；警告逐条判断是否可接受

□ 14. 每个模型都显式声明了 capabilities.input.image
      判据：grep 源码里每个模型定义都有 image: true/false，没有省略；
            text-only 用 { input: { text: true, image: false, audio: false, video: false, pdf: false } }
      出处：HOOKS 十一之三（不写 = 厂商未表态，magpie 会按 models.dev 裸 id 投票误判）

□ 15. accountId 是人看的名字，uid 是身份
      判据：卡片上不会出现 `iam::…` / `urn:…` / uuid / `hw0000…` 这类 ID；
            手机号（去掉国家码后 ≥11 位）是打码的（`138****8000`）；短号不显示；名字取不到时是**空串**而不是 ID；
            多账号重复登录仍是替换（slug 不变）
      出处：HOOKS 八 · src/credential.mjs 的 displayNameOf / accountNameOf（CNB 的 username 是 cnb.xxxx 生成的，名字取 nickname）

□ 16. 包名是 slug，显示名在 magpie.name
      判据：package.json.name 只含小写 ASCII（`^(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$`），
            不含空格/中文/大写；package.json.magpie.name 是「中文 + English」（含空格），
            英文按厂商官方品牌字样大小写照抄（如 `华为云 HUAWEI`，不是 `Huawei`）；
            provider name 与 registry-entry.json.name 同显示名；都不含占位符；
            registry-entry.json.package 是 npm 包名，不是显示名
      出处：README「包名是 slug；显示名写 magpie.name」/ UPDATING「旧版带空格依赖键」

□ 17. 每个错误出口都带 status + code，code 在 ERROR-CODES 词表内
      判据：node scripts/check-error-codes.mjs . 退出码 = 0；
            errorResponse / SSE 错误帧的 code 都在词表里，没有自造的
      出处：ERROR-CODES.md §3 词表 · §4 R1/R2/R6

□ 18. 错误分类对得上「谁该做什么」
      判据：404 只出现在「模型不存在」；超时类落 503/504 不落 502；
            非登录问题的 401 带 X-Magpie-Sign-In: kept；
            message 里保留上游原文，不是「服务异常」四个字；
            词表里每个用到的 code 都有测试
      出处：ERROR-CODES.md §2 状态码表 · §4 R4/R5/R7/R8/R9 · §8 验收清单

□ 19. 出站 User-Agent 是官方客户端 UA，不是我们自己的产品名
      判据：node scripts/check-ua.mjs . 退出码 = 0；
            插件里搜不到 `magpie/…` / `magpie-xxx/<ver>` / `"node"` / `Bun/…` /
            截断的 Mozilla（缺 `(KHTML, like Gecko) Chrome/… Safari/537.36`）；
            官方是网页的是完整 Chrome UA，有 App / CLI 客户端的是那个客户端的 UA；
            loader 的 `fetch` 包装里 `"user-agent"` 在跳过名单内、由插件补官方值
      出处：模板坑表第 38 条 · scripts/check-ua.mjs
```

---

## B 表 · 发版前（分支 + PR + 受控发布）

> ⚠ **禁止直接推 `main`。** git 源用户跟随默认分支 HEAD；未验证提交一旦进去，
> 就会直接抵达正在使用的人。唯一入口是功能分支经 **PR** 且 `rules` 全绿后合并
> （PR 是分支保护的硬要求，不是仪式；批准数 0 = 自己就能合）。

```
□ 第 0 步 · 起功能分支
      命令：git switch main && git pull --ff-only origin main && git switch -c feat/<改动>
      判据：当前不是 main；基线是最新 origin/main

□ 第 1 步 · 写更新内容 + bump version
      命令：npm version patch --no-git-tag-version
      判据：CHANGELOG 顶部是这个版本；package.json 的 version 变了
      出处：UPDATING 二 / 四

□ 第 2 步 · 合规、语义测试、打包面全过
      命令：node scripts/check.mjs && npm test && npm pack --dry-run
      判据：三条退出码全是 0；没有 || true；包里有 README / CHANGELOG / docs
      出处：UPDATING 二 · 第 2 步

□ 第 3 步 · 提交并推功能分支
      命令：git push -u origin feat/<改动>
      判据：推的是功能分支，不是 main；一条 commit 一件事

□ 第 4 步 · PR 全绿后合并
      命令：gh pr create --base main --fill && gh pr checks --watch
      判据：rules 成功、分支最新、讨论已解决，然后才合并
      出处：UPDATING 二 · 第 4 步

□ 第 5 步 · 从已合并的默认分支发 npm
      命令：git switch main && git pull --ff-only origin main
            node scripts/release.mjs --yes --npm
           （npm 名与 package.json.name 不同时自动用 npm run publish:npm）
      判据：HEAD == origin/main；发布脚本没有推 main；返回 `+ <包名>@<版本>`；
            `npm run publish:npm` 发完 package.json.name 仍是 slug（不是 npm 名）；magpie.name 仍是显示名；
            release.yml 引用 `NPM_TOKEN`；未配 secret 时 workflow **失败**，不能 exit 0 假绿

□ 第 6 步 · tag + GitHub Release
      命令：git tag v<version> && git push origin v<version>（release.mjs 已做则跳过）
      判据：tag 指向已合并提交且与 version 一致；Release 不是 draft
      ⚠ release.yml 会再次验证祖先关系、版本、测试和 pack，失败就不发

□ 第 7 步 · 五条验证（每条都要真跑）
      ⓪ node scripts/check-maintenance.mjs → 退出码 0（改了代码必须 bump / bump 必须打 tag）
      ① npm view <包名> version            → 已是新版本
      ② 下载 dist.tarball 解包看内容       → 别只看版本号，要看到新代码
      ③ magpie plugin list                → 本机认得新版本（git 源看 commit）
      ④ GET /releases/tags/v<version>     → 200 且 draft=false
      判据：五条全过；没过不许说「已发布」
      出处：UPDATING 二 · 第 7 步
```

⚠ **npm 登记有延迟。** `npm publish` 返回成功时 registry 可能还查不到新版本，
实测约 1-2 分钟才出现。**别在这个窗口里当成失败重发** —— 重发会撞「同版本号已存在」。

---

## 发完之后

```
□ 用户侧说「有新版本但没动静」
      git 源：只提示、不自动更新，用户要自己点界面里那一行的「更新」按钮
      npm 源：magpie 会自动更新
      判据：先看 `~/.config/magpie/plugin-updates.json` 的 `waiting[]` 里有没有它

□ 用户侧说「更新了但没变化」
      判据：`magpie plugin list` 里的版本/commit 真的换了；插件自己写的缓存文件 mtime
            在更新之后被重建过（没变 = 新代码没加载）
      出处：AGENTS.md 坑 10

□ 破坏性变更
      判据：README 顶部有迁移说明，CHANGELOG 标了 ⚠ 破坏性
```
