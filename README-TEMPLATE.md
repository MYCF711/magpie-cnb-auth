# README 模板

搭 magpie 插件时，把这份结构抄进你的 `README.md`，替换掉尖括号里的内容。

> 为什么单独放一份：**用户打开 README 只想知道三件事** —— 能拿到什么、有哪些功能、怎么装。
> 实现细节、协议取证、反向验证这些，写给自己看的，放 `docs/internals.md`。

---

## 结构

按这个顺序，一份都不多：

| 段 | 回答的问题 | 篇幅 |
|---|---|---|
| 标题 + 一句话 | 这是什么，能拿到什么 | 1 行 |
| 数字块 | 最硬的回报，代码块竖排 | 2-4 行 |
| 功能 | 每条一句话，说「能干什么」不说「怎么实现」 | 5-8 条 |
| 模型 | 先写**哪几家发行商**，再列各家最新/热门 | 3-8 行 |
| 签到 / 定时 | 一句话，幂等的就说明 | 1-2 句 |
| 安装 | 应用内怎么装 → 命令行（追加在末尾） | 短 |
| 常见问题 | **真实被问到的**，不是你想解释的 | 3-6 条 |
| 参考源 | 用了谁的代码 / 抄了谁的协议结论 | 表格，几行 |
| 许可 | 一行 | 1 行 |

> 另外，README **末尾（许可上方）加一行**：
> `> 更新记录：[CHANGELOG.md](./CHANGELOG.md)`
> 卡片正文就是 README —— 这是用户唯一看得见的路标。
> 更新内容本身写在 `CHANGELOG.md`，发版流程见 [UPDATING.md](./UPDATING.md)。

## 硬规则

1. **开头给数字，不给铺垫。** 用户扫一眼就知道值不值得装。
2. **功能一句话。** 「积分算得准」够了，不要解释 `used` 是路由输入。
3. **不踩别人。** 「某某插件做不到 X」是取证，不是卖点。放 internals。
4. **安装放最后。** 没人先看安装再决定要不要。
5. **具体余额、具体账号、具体 ID 一律不进 README。** 写成上限 / 示例占位。
6. **技术细节全部丢 `docs/internals.md`。**
7. **参考源必须写。** 用了别人的协议结论、照着别人的实现抄的，列出来。
   这是别人的劳动，也是 MIT 的要求；顺带让读者知道这东西的依据在哪。
   只写「来源 + 用在哪」，不展开。
8. **模型段写发行商，不写数量；表格只放最新/热门。** 「支持 27 个模型」装完就对不上
   （平台目录 ≠ 计费清单，两个数经常对不上），而且这个数还要跟着平台上下架维护。
   用户判断的只是「我要的那几家在不在」—— 开头写 `DeepSeek / GLM / GPT`，
   表格每家留**最新**的和**热门**的一两行，全量交给应用内的 `magpie plugin list`。

---

## 骨架（复制这段改）

```markdown
# <中文 English> for magpie

**<最硬的一句回报，带数字>**

<一句话说清这是什么服务。>

\`\`\`
<竖排的回报数字，每行一个维度>
\`\`\`

---

## 功能

- **<功能一>** —— <一句话说能干什么>
- **<功能二>** —— <一句话>
- ...

---

## 模型

**<发行商一> / <发行商二> / <发行商三>** —— 各家最新的一版都在；登录后跟随平台目录上下架。

| 发行商 | 代表模型 | 上下文 | <能力列> | 倍率 |
|---|---|---|---|---|
| <发行商一> | `<最新旗舰 id>` | `<window>` | ✓/✗ | `<rate>` |
| <发行商一> | `<最新 flash 档 id>` | `<window>` | ✓/✗ | `<rate>` |
| <发行商二> | `<最新旗舰 id>` | `<window>` | ✓/✗ | `<rate>` |
| <发行商三> | `<热门 id>` | `<window>` | ✓/✗ | `<rate>` |

<思考档位 / 特殊能力，一两句>

> 只列各家的最新与热门。模型目录随时上下架，全表抄进 README 一个月就过期；
> 装好以后 `magpie plugin list` 拿到的才是真实的全部。

---

## <签到 / 定时任务>

<一句话：多久一次、做什么、是不是幂等、失败会不会影响别的>

---

## 安装

在 magpie 的 **插件 → 发现** 搜 `<名字>`，点**安装**。

<必须提醒的冲突，比如先卸掉同类插件>

> 卡片标题来自 `package.json.magpie.name`（`shownName()` 优先取它），写 `<中文> <English>`，
> 可带空格；`package.json.name` 必须是 slug（bun 依赖键 / npm 名），不能带空格。
> 英文部分按厂商官方品牌字样的大小写照抄（例如 `华为云 HUAWEI`）。
> npm 名由 `scripts/publish-npm.mjs` 的 `PUBLISH_AS` 注入，发布时临时替换。
> provider 的 `name` 同显示名。模板默认 `name = "unnamed-plugin"`、
> `magpie.name = "⚠ 未命名插件 Unnamed Plugin"`，看到占位符就说明身份还没改，`check.mjs` 会失败。
> 完整机制见 [UPDATING.md](./UPDATING.md) 的「卡片标题：magpie.name」。

### 命令行

\`\`\`bash
# 从 npm（推荐）
magpie plugin add <npm-包名>

# 从仓库源码（拿最新代码，不走 npm）
magpie plugin add github:<owner>/<repo>

# 本地 tgz（自己改了代码）
npm pack --pack-destination ./dist
cp dist/<包名>-*.tgz ~/.config/magpie/plugins/dist/
# plugins.json          追加 { "spec": "<包名>" }
# plugins/package.json  追加 "<包名>": "./dist/<包名>-*.tgz"
cd ~/.config/magpie/plugins && ~/.cache/magpie/bun/1.4.4/magpie-bun.exe install
\`\`\`

⚠ **`magpie plugin add <tgz路径>` 用不了** —— 它把 tgz 当 JS 模块 `import()`，报
`exports no OpenCode plugin function`。本地包必须走上面那套 `plugins.json` 登记 + `bun install`。

装完确认：

\`\`\`bash
magpie plugin list
# <包名>  on
#   <provider> (<名字>, <N> models)  signed in as <账号>
\`\`\`

⚠ 改了代码要 **bump `version` 再打包** —— 同一版本号重打，bun 会命中缓存（输出 `no changes`）。

---

## 常见问题

**<真实被问到的问题>？** <一句话答案>

---

## 参考源

<按各自许可声明。完整版权声明放 NOTICE.md，这里只列「来源 + 用在哪」。>

| 来源 | 用在哪 |
|---|---|
| [<owner/repo>](<链接>)（<许可>） | <哪个字段 / 哪段协议 / 哪个判据取自这里> |

---

> 更新记录：[`CHANGELOG.md`](./CHANGELOG.md)

## 许可

MIT。
```
> `NOTICE.md` 放完整版权声明（衍生自哪些项目、各是哪一段），`README` 只放索引表。
> 别人的代码是别人的劳动，MIT 也要求保留声明 —— 顺带让读者知道依据在哪。

---

## 仓库里还该有什么

README 只是门面。这几样缺一个，装机的人就会卡：

| 文件 | 作用 | 注意 |
|---|---|---|
| `docs/internals.md` | 实现细节、协议取证、反向验证、本地安装法 | README 里所有「为什么」都挪到这 |
| `CHANGELOG.md` | 每个版本一节，**一条一行**说用户能感知的变化 | README 末尾指一行过来；发版流程见 [UPDATING.md](./UPDATING.md) |
| `NOTICE.md` | 完整版权声明：衍生自哪些项目、各是哪一段 | README 的「参考源」指向它 |
| `LICENSE` | **必须是与官方模板逐字一致的正文** | 见下 |
| `AGENTS.md` | **给 AI 执行者的入口**：按阶段给阅读顺序 + 十几条会静默出错的坑 | 从模板派生时一起带走，改一行都不用 |
| `CHECKLIST.md` | 两张勾选表：代码交付前 / 发版前 | 同上；`check.mjs` 查不到的那部分在这里 |

> **AI 执行这两份尤其重要**：它决定的是「一个不熟悉这个仓库的 AI，会不会漏掉
> 发布那一步」。实测过：只读 `README` 顶部旧版「必读三份」的 AI，会把 `git push`
> 当成发布完成 —— 因为发布流程在 `UPDATING.md`，而它当时不在那份清单里。现在的
> `AGENTS.md` + 顶部「必读四份」就是为堵这个洞。

### ⚠ LICENSE 写错，GitHub 就认不出，卡片会缺许可那一格

magpie 从**仓库**读 license，不是从 npm。把归属说明插在版权行和许可正文之间，
GitHub 的分类器会放弃解析：

```
MYCF711/magpie-officeace  → NOASSERTION   ← 卡片没有许可那一格
MYCF711/magpie-plugin-scaffold → MIT
```

**做法**：MIT 正文一字不动占满整个 `LICENSE`，归属说明放 `NOTICE.md`。自查：

```bash
# 1. 取 GitHub 认的那份 MIT 正文
curl -s https://raw.githubusercontent.com/github/choosealicense.com/gh-pages/_licenses/mit.txt \
  | sed -n '/^Permission is hereby granted/,/SOFTWARE\.$/p' > /tmp/canon.txt

# 2. 从自己的 LICENSE 里切出同一段
sed -n '/^Permission is hereby granted/,/SOFTWARE\.$/p' LICENSE > /tmp/ours.txt

# 3. 逐字比对，无输出才合格
diff /tmp/canon.txt /tmp/ours.txt
```

改完 push，GitHub 一分钟内重新识别。

### ⚠ 包名先查 npm，撞名会装成别人的包

magpie 的「有新版本」按**包名**查 npm，跟仓库属主无关。撞名 = 界面提示别人的新版，
点「更新」把别人的包装进来：

```bash
npm view <包名> version     # 有输出 = 被占了，换个名
```

显示名、npm 包名、依赖键**不是同一个东西**，改名时分别改对：

| 位置 | 填什么 |
|---|---|
| `package.json` 的 `name` | slug（bun 依赖键 / npm 名）：小写 ASCII，无空格，如 `huawei` |
| `package.json.magpie.name` | 卡片显示名：`<中文> <English>`（可带空格，如 `华为云 HUAWEI`） |
| provider 的 `name` | 供应商显示名：同 `magpie.name` |
| `scripts/publish-npm.mjs` 的 `PUBLISH_AS` | npm 包名（小写 ASCII，无空格） |
| `registry-entry.json` 的 `package` | npm 包名 |
| `registry-entry.json` 的 `name` | 显示名（市场卡片标题，可带空格） |
| magpie 侧 `plugins.json` 的 `spec` | npm 包名（npm 安装）或 `github:owner/repo`（git 安装） |
| `plugins/package.json` 的 `dependencies` 键 | 包名 slug（git 安装时由 bun 按包内 `name` 写入；**不能有空格**） |

`create.mjs` 会把这几处一起填好；手工克隆时照这张表逐项改。只改一处会在市场、git 安装或
npm 更新里静默错位。`package.json.name` 带空格时 `magpie plugin update` 会直接报
`unrecognised dependency format`；显示名放 `magpie.name` 就不会碰到依赖键。

### keywords 决定能不能被搜到

magpie 搜索走 npm 的 `/-/v1/search`。`keywords` 要含 `opencode` + `plugin`/`auth`/`provider`
之一，否则搜不到。实测 `<厂商名>` 这种词最有效。

```json
"keywords": ["magpie", "magpie-plugin", "opencode", "opencode-plugin", "opencode-auth", "<厂商>"]
```

---

## 反例对照

同一件事，两种写法：

| ❌ 不要 | ✅ 要 |
|---|---|
| 「本插件实现了 `windowsOf`，把两池读数按 magpie 的路由语义分池上报，因为宿主归一化时用 `Math.max(0, num(w?.used))`，缺省即 0……」 | 「**积分算得准** —— 空号就显示空，不会被优先派活」 |
| 「别的插件不报 `used`，导致 256 次路由里 255 次命中空号」 | 同上，或直接删 |
| 「余额 24,860 永久积分」 | 「永久积分 最多 25,000」 |
| 「支持 27 个模型」 | 「**DeepSeek / GLM / GPT / Kimi** 的最新模型都在」 |
| 把模型目录整表贴进 README（十几行起） | 每家最新 / 热门一两行 + 一句「全量看 `magpie plugin list`」 |
| 「在 `authorize()` 里立刻返回，因为死等会和 magpie 双向死锁」 | （这句放 HOOKS.md / internals） |

---

## 完整实例

`MYCF711/magpie-loomy-auth` 的 README 是按这份模板写的，可以对照：
[github.com/MYCF711/magpie-loomy-auth](https://github.com/MYCF711/magpie-loomy-auth)

> 它写在「模型段」改版之前，那一段还是旧写法（整表列出）。**模型段以本模板为准** ——
> 发行商开头，表格只留各家最新 / 热门。
