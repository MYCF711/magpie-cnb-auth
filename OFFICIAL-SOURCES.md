# 官方指导文件引用索引

> **本仓库是 `usemagpie.ai/docs/plugins` 与 `yetone/magpie` 的衍生说明书。**
> 官方原文的版权归 yetone，以 MIT 许可发布；本仓库引用其结论，并在每条后面补上「官方没写的后果」。
>
> - 官方文档（中文）：<https://usemagpie.ai/docs/zh/plugins>
> - 官方文档（英文）：<https://usemagpie.ai/docs/plugins>
> - 官方仓库：<https://github.com/yetone/magpie>（MIT License, Copyright (c) 2026 yetone）
> - 插件子系统参考：`docs/subsystems/provider-plugins.md`（64,931 字节，2026-10-28 仍在更新）
>
> **引用基线**：本文核对于 **2026-10-28**，对应 magpie 稳定版 **0.1.1327**、
> 官方仓库 `main` 的 `provider-plugins.md` 最后修改 `d4f1d648`（2026-10-28T14:20:56Z）。
> 重新核对：`node scripts/check-magpie-stable.mjs` —— 它报 `2`（稳定版变了）时，本文件的
> 基线就过期了，按它打印的三步走。

---

## 这份文件解决什么问题

官方文档告诉你**规则**（钩子叫什么、返回值什么意思）。它不告诉你：

- 少写一个字段会怎样（多数时候**不报错**，只是某个能力静默消失）
- 写错一个值会怎样（比如把模型级错误写成 401，整个账号会被停用）
- 发出去之后会怎样（许可被标成 `NOASSERTION`、卡片上没有那一格）

本索引做的事：**把官方 22 个锚点逐条映射到本仓库的对应章节，并标出「官方讲了的」和「官方没讲、我们补的」**。
这样任何人（尤其是模型）读到任何一条结论时，都能知道它站在哪个官方原文上。

---

## 一、官方锚点 → 本仓库映射（22 条）

图例：**官方** = 官方原文已覆盖；**补充** = 官方未写、本仓库的实测结论。

### 1. 入门

| # | 官方锚点 | 官方讲什么 | 本仓库对应 | 增量 |
|---|---|---|---|---|
| 1 | [`#quick` 五分钟写一个插件](https://usemagpie.ai/docs/zh/plugins#quick) | Acme 完整示例：package.json + index.mjs（config / auth / provider / usage / checkin） | [README「怎么用」](./README.md)、[index.mjs](./index.mjs) | **补充**：官方示例只有 1 个插件函数、6 个钩子里的 4 个；本模板九项齐全，含 `chat.headers` |
| 2 | [`#run` magpie 如何运行插件](https://usemagpie.ai/docs/zh/plugins#run) | Bun 宿主、一进程多插件、stdin/stdout JSON、安装与重启、代理、更新 | [HOOKS 一](./HOOKS.md)、[AGENTS 坑 18](./AGENTS.md) | **补充**：宿主是同一个进程跑所有账号 → 模块级变量会串号（坑 16） |
| 3 | [`#package` 包的结构](https://usemagpie.ai/docs/zh/plugins#package) | 入口查找顺序、模块导出规则（每个导出函数都会被当插件）、`magpie.icon` / `maxConcurrency` | [README 顶部四件](./README.md)、[check.mjs](./scripts/check.mjs) | **补充**：`_internal` 对象导出不会被当插件；`check.mjs` 会逐项验 |

### 2. 供应商与模型

| # | 官方锚点 | 官方讲什么 | 本仓库对应 | 增量 |
|---|---|---|---|---|
| 4 | [`#provider` 供应商与模型](https://usemagpie.ai/docs/zh/plugins#provider) | `config.provider[id]`、models 字段、`limit` / `cost` / `variants` | [HOOKS 十一](./HOOKS.md)、[src/models.mjs](./src/models.mjs) | **补充**：`free` 不能从 `rate === 0` 反推（实测 51 条 `rate=0` 里 38 条仍吃套餐额度） |
| 5 | [`#searches` 自己能联网搜索的上游](https://usemagpie.ai/docs/zh/plugins#searches) | provider 级 `searches: true`；模型级 `searches: true` | [HOOKS 十一之三](./HOOKS.md) | 官方已覆盖；本仓库补「不写 = 能力关掉，且不报错」 |
| 6 | [`#decide` 决策 API（System One）](https://usemagpie.ai/docs/zh/plugins#decide) | `decide: true` + 模型 `decides: true`、`/systemone` 请求形状 | [HOOKS 十一之三](./HOOKS.md) | 官方已覆盖 |
| 7 | [`#apis` 模型使用的 API](https://usemagpie.ai/docs/zh/plugins#apis) | 五种 AI SDK 包 → 协议、baseURL 优先级、`model` 用哪个 id | [HOOKS 十一](./HOOKS.md) | **补充**：插件供图的判据（`DrawsID` + `ImagesAPI` + `@ai-sdk/openai-compatible`），来自 Go 实现而非文档 |

### 3. 登录

| # | 官方锚点 | 官方讲什么 | 本仓库对应 | 增量 |
|---|---|---|---|---|
| 8 | [`#signin` 登录](https://usemagpie.ai/docs/zh/plugins#signin) | api / oauth 两种方式、`authorize` 返回形状、`prompts`、账号与 `inScope`、`client.auth.set` | [HOOKS 二～五](./HOOKS.md)、[MULTI-PROVIDER](./MULTI-PROVIDER.md) | **补充**：`authorize()` 必须立刻返回，网络请求挪到 `loader`（铁律 2） |
| 9 | [`#renew` 续期登录](https://usemagpie.ai/docs/zh/plugins#renew) | `auth.refresh`、`refreshLead`、串行化、合并保存、`signIn: "expired"` | [HOOKS 六](./HOOKS.md) | **补充**：`refresh` 返回的是**合并**结果（铁律 3）—— 只给新字段会覆盖旧的 |

### 4. 请求与错误

| # | 官方锚点 | 官方讲什么 | 本仓库对应 | 增量 |
|---|---|---|---|---|
| 10 | [`#requests` 请求](https://usemagpie.ai/docs/zh/plugins#requests) | loader 返回什么、请求头顺序、`fetch` 拿到的 `init`、流式转发 | [HOOKS 七～八](./HOOKS.md)、[src/chat.mjs](./src/chat.mjs) | **补充**：不要在 `fetch` 里读流（常见坑 5）；流式要补 `include_usage` |
| 11 | [`#signin-state` 登录状态](https://usemagpie.ai/docs/zh/plugins#signin-state) | 401 默认打标记、`X-Magpie-Sign-In` 三个值、`signIn: "expired"` | [HOOKS 十](./HOOKS.md) | **补充**：模型级错误返回 **404** 不是 401 —— 401 会打死整个账号（常见坑 2） |

### 5. 用量与签到

| # | 官方锚点 | 官方讲什么 | 本仓库对应 | 增量 |
|---|---|---|---|---|
| 12 | [`#usage` 用量](https://usemagpie.ai/docs/zh/plugins#usage) | `auth.usage` 全部字段：plan / balance / windows（used / resetsAt / span / amount / limit / aside / runsOutAt / runsOut / balance） | [HOOKS 三](./HOOKS.md) | **补充 → 已反向补进官方**（[#468](https://github.com/magpie-community/plugins/issues/468)，v0.1.1934）：窗口的占比**只看 `used`**（没有 `used` 的窗口是 text-only、路由不计入；≥ 0.1.1934 起有 amount/limit 时会推算）；时间必须是 ISO；`aside` 窗口**路由从不读**，只上卡片 |
| 13 | [`#checkin` 签到](https://usemagpie.ai/docs/zh/plugins#checkin) | `auth.checkin`、六个 outcome、北京时间每天一次、失败重试 | [HOOKS 九](./HOOKS.md) | 官方已覆盖（2026-10-26 由 issue #392 补上，v0.1.1582，三语） |

### 6. 运行时输入

| # | 官方锚点 | 官方讲什么 | 本仓库对应 | 增量 |
|---|---|---|---|---|
| 14 | [`#input` 插件能拿到什么](https://usemagpie.ai/docs/zh/plugins#input) | `client.auth.set` / `.remove`、`client.app.log`、`client.config.get`，其余返回 `undefined` | [HOOKS 五](./HOOKS.md)、[src/store.mjs](./src/store.mjs) | **补充**：按账号落盘的文件名规则（坑 16） |
| 15 | [`#ids` 供应商的 id](https://usemagpie.ai/docs/zh/plugins#ids) | 内置订阅的 id 表、`<id>-plugin` 的接管规则 | [MULTI-PROVIDER](./MULTI-PROVIDER.md) | **补充**：一个包两个供应商时，`auth` 里不能存站点字段（五条铁律） |

### 7. 测试与发布

| # | 官方锚点 | 官方讲什么 | 本仓库对应 | 增量 |
|---|---|---|---|---|
| 16 | [`#test` 测试](https://usemagpie.ai/docs/zh/plugins#test) | 沙箱 HOME 的一套命令：`m plugin add` / `plugin` / `login` / `provider test` / `quota` / `logout`；`bun test`；`_internal`；`bun scripts/check.mjs`；`scripts/try.sh` | [CHECKLIST A](./CHECKLIST.md)、[tests/semantics.test.mjs](./tests/semantics.test.mjs) | **补充**：check.mjs 里「发布合规」那一层（许可逐字 MIT、registry-entry 一致、icon 大小、无真 JWT、无硬编码本机路径）—— 官方和社区脚本都不查 |
| 17 | [`#publish` 发布与上架](https://usemagpie.ai/docs/zh/plugins#publish) | npm 包名 / keywords / README / `registry.json` 推荐位 / `MAGPIE_PLUGIN_MARKET` / GitHub topic `magpie-plugin` / 社区仓库命名 | [UPDATING](./UPDATING.md)、[README-TEMPLATE](./README-TEMPLATE.md) | **补充**：只能推功能分支，PR 全绿合并后才发布；同版本重打包会命中 bun 缓存 |

### 8. 官方文档的其余锚点（本仓库不涉及，但要知道它们存在）

| # | 官方锚点 | 是什么 | 什么时候需要 |
|---|---|---|---|
| 18 | [`#gateway-request` 异步钩子（网关请求）](https://usemagpie.ai/docs/zh/plugins#gateway-request) | 网关中间件在请求/响应上的钩子 | 写 middleware 时 |
| 19 | [`#middleware` 网关中间件](https://usemagpie.ai/docs/zh/plugins#middleware) | `magpie.middleware`、`onRequest` / `onEvent` / `onResponse` | 不是供应商插件时 |
| 20 | [`#tools` 给每个 agent 的工具](https://usemagpie.ai/docs/zh/plugins#tools) | 插件可以提供工具，不一定要登录 | 工具类插件 |
| 21 | [`#agents` / `#pages` / `#pi` / `#protocol`](https://usemagpie.ai/docs/zh/plugins#agents) | Agent 扩展、GUI 页面、pi 扩展包、插件协议 | 非供应商插件 |
| 22 | [`#faq` 常见问题](https://usemagpie.ai/docs/zh/plugins#faq) | 官方 FAQ | 卡住时先看 |

---

## 二、官方没写、本仓库负责的部分（增量清单）

这一节是「说明书」的真正价值 —— **每条都能在官方文档里找到「没有」的证据**（2026-10-28 核对）。

| # | 结论 | 官方原文状态 | 证据 | 本仓库出处 |
|---|---|---|---|---|
| 1 | `free` 只来自厂商声明；`rate: 0` 是「没给倍率」 | **已进官方文档**（#468，v0.1.1934） | 补之前 `grep -c "rate === 0" provider-plugins.md` = **0** | [HOOKS 十一之二](./HOOKS.md) |
| 2 | 模型级错误用 403 / 404，不用 401 | **已进官方文档，且比我们报的更宽**（#468）：401 会 failover 到**每一个账号**，`3ec25523c` 起才按 body 判断 | 补之前 `grep -c "404" provider-plugins.md` = **0** | [README 常见坑 2](./README.md) |
| 3 | 窗口「有没有占比」只看 `used`，与 `aside` 无关；`aside` 窗口路由从不读 | **已进官方文档**（#468，v0.1.1934） | 我们原来的因果说反了：曾以为 `aside` 让窗口变 text-only，实际是没有 `used`；`aside` 是路由**显式**跳过的另一个独立条件 | [HOOKS 三 规矩 ①](./HOOKS.md) · [`src/quota.mjs`](./src/quota.mjs) |
| 4 | `LICENSE` 夹了归属说明 ⇒ GitHub 判 `NOASSERTION` | **已进官方文档，并加了回退**（#468，`5957d45ac`）：`NOASSERTION` 的 listing 改用 `package.json` 的 `license` | 补之前官方中文文档里「许可/license」只出现 1 次；`grep -c "NOASSERTION"` 官方文档 = 0 | [README 顶部四件](./README.md) |
| 5 | 同版本重打包命中 bun 缓存，行为不变 | 未提 | 官方 `#run` 只讲「重启」，未讲缓存 | [AGENTS 坑 10](./AGENTS.md) |
| 6 | `magpie plugin add xxx.tgz` 有 bug | 未提 | 官方 `#run` 只讲 npm / git / 文件夹三种来源 | [README 常见坑 1](./README.md) |
| 7 | 只能推功能分支，PR 全绿合并后才发布 | 官方 `#publish` 讲「推到 main 就发」，但没给分支保护与检查门 | 官方 `#publish` = 叙事，无步骤门 | [UPDATING](./UPDATING.md) · [CHECKLIST B](./CHECKLIST.md) |
| 8 | `registry-entry.json` 与 `package.json` 的 `name` 必须一字不差 | 官方 `#publish` 给了 registry 条目示例，没说要和 package.json 对齐 | 官方示例是独立片段 | [check.mjs](./scripts/check.mjs) |

> ⚠ 这份清单会随官方文档更新而缩短 —— 这是**正常**的。每次 `check-magpie-stable.mjs` 报 `2` 时，
> 把上面 8 条逐条回官方原文核一遍，已经从「官方没写」变成「官方写了」的，就删掉或降级为「官方已覆盖」。

---

## 三、引用规矩（写任何一份文档时照做）

1. **每条结论后面必须能追到官方锚点**（`#usage`、`#checkin` 这种），或者明确标「补充」。
2. **引用官方原文不超过 3 行**；要更多就放链接，不要复制整段 —— MIT 允许复制，但说明书的价值是「消化」不是「搬运」。
3. **每个「补充」必须带判据**（能跑的命令、能看的字段），写不成判据的，是感想，不进这份索引。
4. **官方文档改了，先改这份索引，再改正文** —— 否则正文会先漂移，索引变成假的。
5. 引用官方仓库的代码片段时，保留 `Copyright (c) 2026 yetone` 与 MIT 声明（见本文件顶部的许可行）。

---

## 四、怎么核对这份索引还准不准

```bash
# 1. 官方稳定版有没有变
node scripts/check-magpie-stable.mjs        # 0 = 没变，2 = 变了

# 2. 官方契约里我们没写的字段还有没有
python extract-contract.py && node scripts/contract-diff.mjs

# 3. 官方文档对应锚点还在不在（抓页面找 id）
curl -s https://usemagpie.ai/docs/zh/plugins | grep -o 'id="[a-z-]*"' | sort -u
```

三条都过，这份索引就不用动。
