# GUIDE —— 30 分钟，从官方指导文件到 80 分插件

> **这份文件是「说明书」，不是「参考手册」。**
> 它只回答一件事：**现在要做一个 magpie 供应商插件，按什么顺序做、每步看哪份东西、什么时候算做完。**
>
> - 要查某个字段的细节 → [HOOKS.md](./HOOKS.md)
> - 要知道每条结论的官方出处 → [OFFICIAL-SOURCES.md](./OFFICIAL-SOURCES.md)
> - 要给自己打分 → `node scripts/score.mjs`，规则见 [SCORING.md](./SCORING.md)
> - 官方原文 → <https://usemagpie.ai/docs/zh/plugins>

---

## 0 · 先确认你在做哪一种

| 你要做的东西 | 官方锚点 | 走这份说明书的哪条路 |
|---|---|---|
| **供应商插件**（登录一个服务，让它的模型能被 agent 用） | [`#quick`](https://usemagpie.ai/docs/zh/plugins#quick) | **本文全部** —— 这是主路径 |
| 网关中间件（改请求/响应，不登录） | [`#middleware`](https://usemagpie.ai/docs/zh/plugins#middleware) | 只读 [§1](#1--拿模板1-分钟) + 官方 middleware 章 |
| 工具 / 页面 / Agent 扩展 | [`#tools`](https://usemagpie.ai/docs/zh/plugins#tools) [`#pages`](https://usemagpie.ai/docs/zh/plugins#pages) | 本文不覆盖，直接看官方 |

⚠ **选错形态是最贵的错**：供应商插件要写 `auth`，中间件不写；把一个 middleware 写成供应商插件，
magpie 会把它当登录入口，用户点开发现没有登录方式。

---

## 1 · 拿模板（1 分钟）

**方式 A（推荐）：GitHub「Use this template」**

在仓库页点 **Use this template → Create a new repository**。它复制目录结构与文件，
**不带 git 历史**；新仓库第一次跑 `node scripts/check.mjs` 就会因占位符失败 ——
这正是提醒你改身份，不是模板坏了。

**方式 B：本地 `create.mjs`**

```bash
node scripts/create.mjs --dir ../my-provider --provider huawei   --name "华为云 HUAWEI" --package huawei-auth --base https://api.huawei.example/v1
```

它会改好身份、删掉 `check:template`，让新仓库直接走严格模式；CI 的 action 自测也会
从 `template: "true"` 改成 `"false"`，不会替派生仓库放行占位符。

**方式 C：手动 clone**

```bash
git clone https://github.com/MYCF711/magpie-plugin-scaffold.git my-provider
cd my-provider && rm -rf .git && git init
```

判据：脚手架自身跑 `npm run check:template` 能过（1 条警告：registry 还是占位）；
改完身份后跑 `node scripts/check.mjs`，显示名/provider name 还是「未命名」占位符就会失败。

⚠ **`scripts/` 和 `src/` 要一起带走，不能只留 `index.mjs`。**
`scripts/check.mjs` 是你自己仓库的检查器，`scripts/score.mjs` 打分时读的正是**你自己仓库里的**
`scripts/check.mjs` —— 删了它，A 层直接 0 分。`src/` 同理：`tests/semantics.test.mjs` import 的就是它。

---

## 2 · 改身份（5 分钟）

要改的身份项（模板默认全是占位符 / 脚手架值）：

| 字段 | 改成什么 | 官方锚点 | 错了会怎样 |
|---|---|---|---|
| `name` | **包名 / bun 依赖键**：小写 ASCII slug，如 `huawei`；**不能有空格/中文/大写** | [`#publish`](https://usemagpie.ai/docs/zh/plugins#publish) | 带空格 → `magpie plugin update` 报 `unrecognised dependency format`；占位符不改 → `check.mjs` 失败 |
| `magpie.name` | **卡片显示名**：`<中文> <English>`，如 `华为云 HUAWEI`；英文照抄官方大小写 | [`#package`](https://usemagpie.ai/docs/zh/plugins#package) | 占位符/缺字段 → 标题退回 slug |
| `scripts["publish:npm"]` | 发布时注入 npm 包名；`PUBLISH_AS` 在 `scripts/publish-npm.mjs` | 同上 | npm 名不对 / 裸 publish 被 registry 拒 |
| `description` | 一句话：签入什么服务、用户得到什么 | 同上 | 发现页只显示这一行 |
| `keywords` | 必须含 `opencode` + `plugin`/`auth`/`provider` 之一 + `magpie` | [`#publish`](https://usemagpie.ai/docs/zh/plugins#publish) | 市场搜不到你 |
| `magpie.icon` | `https://` 或 `data:image/`，≤1MB | [`#package`](https://usemagpie.ai/docs/zh/plugins#package) | 卡片上没有图标 |
| `repository` | 你自己的仓库地址 | [`#package`](https://usemagpie.ai/docs/zh/plugins#package) | 卡片上没有「源码」按钮 |

⚠ **`name` 不是显示名，也不是 npm 名**：npm 名写在 `scripts/publish-npm.mjs` 的 `PUBLISH_AS`；
显示名写在 `package.json.magpie.name`（`shownName()` 优先取它）。`name` 只做 slug / bun 依赖键。
provider 的 `name` 与 `registry-entry.json.name` 也放显示名，可带空格。

**provider id 怎么定**：取官方 `#ids` 里已有的 id（如 `grok`、`zcode`）—— 插件会显示成
`<id>-plugin`，等 magpie 内置订阅退役后接管同一个 id。**不要自创一个和内置重复的 id。**

**新插件必须换掉 CHANGELOG**：把模板的 `CHANGELOG.md` 清空，写你自己的 `## 0.1.0 — <日期>` 一节
（说清这个版本给用户什么）。`version` 改成 `0.1.0`，`package.json` 的 `name` 换掉之后，
如果 CHANGELOG 里找不到当前版本，`check.mjs` 会直接失败。

判据：`node scripts/check.mjs` 里「package.json 的 name 不是占位符」「magpie.name 不是占位符」「provider name 不是占位符」「registry 一致性」「CHANGELOG 有当前版本」变绿；`name` 是 slug，`magpie.name` / provider name / registry name 同时含中文与 English。

---

## 3 · 写 `config`（5 分钟）—— 模型表

打开 `index.mjs`，改顶部常量：

```js
const PROVIDER = "huawei"                     // = auth.provider，也是模型前缀
const PROVIDER_NAME = "华为云 HUAWEI"          // 中文 + English，英文照抄官方大小写
const BASE = "https://api.huawei.example/v1"
const SDK = "@ai-sdk/openai-compatible"       // 决定 API 形状，见官方 #apis
const MODELS = [
  ["huawei-coder", "Huawei Coder", 200_000],
]
```

**`config.models` 不能为空** —— 它是 magpie 还没人登录时显示的模型列表。空 = 用户装上以为没装成。
静态占位也算，登录后由 `provider.models` 覆盖。

判据：`node -e "import('./index.mjs').then(async m=>{const h=await Object.values(m)[0]({client:{}});const c={};await h.config(c);console.log(Object.keys(c.provider))})"`
打印出你的 provider id。

官方锚点：[`#provider`](https://usemagpie.ai/docs/zh/plugins#provider) · [`#apis`](https://usemagpie.ai/docs/zh/plugins#apis)
细节：[HOOKS 十一](./HOOKS.md)

---

## 4 · 写 `auth`（10 分钟）—— 登录

两种登录，选一种：

| 方式 | 什么时候用 | 形状 |
|---|---|---|
| `{ type: "api" }` | 厂商给 API key | `methods: [{ type: "api", label: "Acme API key" }]` |
| `{ type: "oauth" }` | 浏览器 / 设备码 | `{ type: "oauth", label, authorize }`，返回 `{ url, instructions, method, callback }` |

**两条铁律**（写错会静默出问题）：

1. **`authorize()` 必须立刻返回** —— 所有网络请求挪到 `loader`。转圈 = 用户以为卡死。
2. **`refresh()` 返回的是合并结果** —— 只给新字段会覆盖旧的，用户被要求重登。

`loader(getAuth)` 返回 `{ baseURL, apiKey, headers, fetch }`；**不要在 `fetch` 里读流**，
把 `Response` 原样交回去。

⚠ **`type: "api"` 没有「格式校验」这一层。** 官方只给 `label` 和 `placeholder`，
没有 method 级的 `validate`；不写 `authorize` 时 magpie 把用户粘的 key **原样保存**。
所以 `placeholder: "nimbus-…"` 只是**提示**，挡不住用户粘一个 `sk-...` 进来 ——
要挡就在 `loader` 里自己判断并返回 `{}`（让请求失败），别指望界面拦。

判据：`node scripts/check.mjs` 的「导出函数返回了钩子」通过；`node --test` 全过。

官方锚点：[`#signin`](https://usemagpie.ai/docs/zh/plugins#signin) · [`#renew`](https://usemagpie.ai/docs/zh/plugins#renew) · [`#requests`](https://usemagpie.ai/docs/zh/plugins#requests)
细节：[HOOKS 二～八](./HOOKS.md) · [README 三条铁律](./README.md)

---

## 5 · 写 `provider.models`（5 分钟）—— 动态模型

如果模型因账号而异，在 `provider` 钩子里返回这个账号的模型表。

**三态降级**（必须选对方向）：

| 情况 | 返回什么 |
|---|---|
| 整个接口失败 | 退回上次快照 / `provider.models`，**不要返回空表** |
| 接口成功但单条缺字段 | **不列**那条（不猜） |
| 登录失效 | 抛 `signIn: "expired"` |

判据：`node --test` 里的三态测试全过。

官方锚点：[`#provider`](https://usemagpie.ai/docs/zh/plugins#provider) · [`#signin-state`](https://usemagpie.ai/docs/zh/plugins#signin-state)
细节：[HOOKS 十一](./HOOKS.md) · [src/models.mjs](./src/models.mjs)

---

## 6 · 写 `usage` / `checkin`（按需）

**`usage` 最常错的三处**（都是「写错不报错」）：

| 错法 | 结果 | 正确做法 |
|---|---|---|
| 窗口有 `amount`/`limit` 却没有 `used` | magpie < 0.1.1934 把它当 text-only 丢掉；≥ 0.1.1934 才用 amount/limit 推算 | 用构造器，它自动补 `used` |
| `resetsAt` 用厂商原样时间 | 解析失败，窗口不显示 | 先转 ISO |
| `used` 缺省 | 被当 0% = 满额，空号排到队首 | 必填，有限数字 |

**别自己拼窗口对象 —— 用 [`src/quota.mjs`](./src/quota.mjs) 的构造器：**

```js
import { usage as buildUsage, usageWindow } from "./src/quota.mjs"

return buildUsage({
  plan: "Pro",
  windows: [
    usageWindow({ name: "5 小时", used: 37, resetsAt: u.resets_at, span: 18000 }),
    usageWindow({ name: "积分", balance: 6291, unit: "积分" }),   // 钱包型：只给 balance
  ],
})
```

上面三种错法**在这个构造器里会直接抛错**，不会变成「GUI 显示不对但日志里什么都没有」。
这几条不是风格问题：额度窗口是 magpie **画卡片**和**智能路由排序**的同一个输入 ——
**判断一条窗口有没有占比只看 `used`** —— 没有 `used` 的窗口路由不计入；`aside: true` 是另一个独立条件，路由也从不读它。一个号所有窗口都不参与路由，它在路由页就是「剩余额度未知」，而且排在已知账号之后。（机制按 [issue #468](https://github.com/magpie-community/plugins/issues/468) 于 2026-10-29 更正）

**`checkin`**：返回 `{ outcome, credit?, streak?, message? }`，`outcome` 只能是
`claimed` / `done` / `ineligible` / `inactive` / `captcha` / `failed` 六个之一。
**永远不要解验证码** —— 返回 `captcha`，让用户去厂商 App 签。

⚠ **上游端点、方法、请求体、字段名，官方一个都不规定** —— 那是厂商自己的 API，由你定。
要遵守的只有**返回形状**：`usage` 里的 `used` / `resetsAt` / `span`，`checkin` 里的
`outcome` 与 `streak`。所以模板里 `fetchUsage` / `doCheckin` 两个函数是空的 —— 不是没写，
是**故意留给你填厂商自己的接口**。多返回的字段（如 `message`）magpie 会忽略，不报错。

判据：`curl -s http://127.0.0.1:3425/v1/magpie/quotas` 看窗口里有没有 `text: true` 和 ISO 的 `runsOutAt`。

官方锚点：[`#usage`](https://usemagpie.ai/docs/zh/plugins#usage) · [`#checkin`](https://usemagpie.ai/docs/zh/plugins#checkin)
细节：[HOOKS 三、九](./HOOKS.md)

---

## 7 · 跑自检（5 分钟）

```bash
node scripts/check.mjs        # 规定：失败必须 0
node --test                   # 语义：16 条必须全过
node scripts/score.mjs        # 打分：身份门通过 + 自动分 ≥55，总分要 ≥80
```

⚠ **`tests/semantics.test.mjs` 不是「照抄就能用」的通用测试** —— 它 `import` 的是
`../src/models.mjs`、`../src/api.mjs`、`../src/chat.mjs`，锁的是模板那套计费/降级实现。
所以 **`src/` 要跟 `tests/` 一起带走**；你要换成自己的实现，就把测试里对应的断言一起改，
否则它测的是模板，不是你的插件。

三条都过，才算「代码写完了」。**没过别往下走。**

---

## 8 · 打分（1 分钟）

`node scripts/score.mjs` 输出 A/B/D 的自动分，和 C/E 的待人工项。

C 层五项要**逐条在代码里找到判据**，不是「我觉得对」。完整规则见 [SCORING.md](./SCORING.md)。

**80 分 = 可以发布。** 低于 80 先补，别急着发。

---

## 9 · 发布前（照 CHECKLIST 的 B 表）

**只推功能分支，不推 main**：写 CHANGELOG → bump → 合规 / 测试 / pack →
推功能分支 → PR 全绿后合并 → `npm publish` → tag + Release → 五条验证。

完整流程：[UPDATING.md](./UPDATING.md) · [CHECKLIST.md](./CHECKLIST.md)

---

## 一页速查：每步对应哪份东西

| 步 | 动作 | 官方锚点 | 本仓库 |
|---|---|---|---|
| 1 | 拿模板 | — | README「怎么用」 |
| 2 | 改身份 | `#package` `#publish` `#ids` | README「然后改三处」 |
| 3 | 写 config | `#provider` `#apis` | HOOKS 十一 |
| 4 | 写 auth | `#signin` `#renew` `#requests` | HOOKS 二～八、README 三条铁律 |
| 5 | 写 models | `#provider` `#signin-state` | HOOKS 十一、src/models.mjs |
| 6 | 写 usage/checkin | `#usage` `#checkin` | HOOKS 三、九 |
| 7 | 自检 | `#test` | check.mjs / tests / score.mjs |
| 8 | 打分 | — | SCORING.md |
| 9 | 发布 | `#publish` | UPDATING.md / CHECKLIST.md |

---

## 如果只记三件事

1. **`config.models` 不能空** —— 空了等于没装。
2. **模型级错误用 404，不用 401** —— 401 会打死整个账号。
3. **只推功能分支** —— PR 检查全绿并合并后才发布；直接推 main 会把坏包分发给用户。

---

## 卡住了去哪查

| 症状 | 先看 |
|---|---|
| 插件装上了，模型列表空的 | [AGENTS 坑 5](./AGENTS.md) |
| 某个模型报错，整个账号被停 | [AGENTS 坑 6](./AGENTS.md) |
| 额度条永远 100% / 路由页「剩余额度未知」 | [AGENTS 坑 1、22、24](./AGENTS.md) |
| 登录莫名失效 | [AGENTS 坑 7](./AGENTS.md) |
| 改了代码重装没变化 | [AGENTS 坑 10](./AGENTS.md) |
| 市场搜不到 | [AGENTS 坑 15](./AGENTS.md) |
| 以上都没有 | [HOOKS.md](./HOOKS.md) 按钩子查 · 官方 [`#faq`](https://usemagpie.ai/docs/zh/plugins#faq) |
