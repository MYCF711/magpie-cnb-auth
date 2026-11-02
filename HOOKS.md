# magpie 插件钩子清单（权威版）

来源：`magpie-windows-amd64.exe` 内嵌的插件契约源码，用 `extract-contract.py` 提取。

**当前基线：`0.1.1327`（稳定渠道 / Stable）**

| 日期 | 提取自 | 结果 |
|---|---|---|
| 2026-10-26 | 0.1.1254（当时最新） | 首次整理（这一份的主体） |
| **2026-10-28** | **`0.1.1327`（stable）** | **基线改到稳定渠道**；补「十一之三」（模型条目的 7 个漏字段 + 插件供图） |
| 2026-10-28 | 0.1.1763（每版本渠道，对照） | 23 段 / 264,822 字符。与 stable 逐字段比对：插件相关的字段**完全一致**；多出的 2 段是 `summaries` / `last seen`（GUI 历史，不是插件契约） |

> ⚠⚠ **判断「要不要同步」看稳定渠道，不看每版本渠道。**
>
> ```bash
> curl -s "https://usemagpie.ai/api/latest?channel=stable" | grep -o '"version":"[^"]*"'
> ```
>
> 每版本渠道一晚能发四个版本（实测 1763→1767），追它追不完，而且大多数是 beta。
> 这就是 magpie 设置里的「更新渠道：每个版本 / 稳定版」——**用户默认跑的是稳定版**，
> 插件契约要跟的是它。两个渠道的数字差得很夸张（2026-10-28：每版本 0.1.1763 /
> 稳定版 0.1.1327），但插件相关的字段一条不差 —— 说明「追每版本」几乎全是白跑。
>
> 稳定版版本号变了，才需要：重新 `extract-contract.py` → 跑 `node scripts/contract-diff.mjs`
> → 看差集里有没有「不写会关掉某个能力」的。

⚠ **内嵌契约抓不到的东西**：`draw`（插件供图）、`DrawsID` / `ImagesAPI` 这些判据
都在 Go 实现和 `docs/subsystems/provider-plugins.md` 里，不在契约源码里 ——
见「十一之三」末尾那段的说明。

**这份契约和 `usemagpie.ai/docs/plugins` 分工**：官方文档讲**行为**（哪个钩子、什么时候调、
返回值什么意思），这里讲**字段**（少写一个会怎样、写错一个会怎样）。
`auth.checkin` 曾经是官方文档的缺口，2026-10-26 已在 magpie **v0.1.1582** 补齐
（en/zh/ja，[issue #392](https://github.com/magpie-community/plugins/issues/392)）——
所以这里不再声称「比官方全」，只声称「比官方细」。

> 一个包装多个供应商（国内 / 国际这种）时，`config` / `auth` / `provider` 三处都要
> 按站点参数化，而 `auth` 里**不能**再存站点字段 —— 写法、五条铁律与验证清单见
> [MULTI-PROVIDER.md](./MULTI-PROVIDER.md)。

---

## 一、六个钩子（不是五个）

```js
export const XxxAuthPlugin = async ({ client }, options) => ({
  // ① 声明 provider 和静态模型表
  config(cfg) {
    cfg.provider ??= {}
    cfg.provider["xxx"] ??= {
      name: "Xxx",
      npm: "@ai-sdk/openai-compatible",
      api: BASE,
      models: staticModels(),      // ⚠ 未登录时也必须有，否则显示 "0 models"
    }
  },

  auth: {
    provider: "xxx",
    icon: "https://...",           // 或 data:image/...
    maxConcurrency: 4,
    refreshLead: 5 * 60_000,       // token 到期前多久续期

    // ② 登录方式
    methods: [{
      type: "oauth",               // 或 "api"
      label: "Sign in with Xxx",
      placeholder: "...",          // api 类型时是输入框提示
      prompts: [],                 // 可选：登录前的问题
      async authorize() {
        return {
          url,                     // magpie 打开
          instructions,            // 显示给用户
          method: "auto",          // "auto" | "code"
          opened: false,           // true = 插件自己已经开了页面
          async callback() {
            return { type: "success", refresh, access, expires, accountId }
          },
        }
      },
    }],

    // ③ 续期
    async refresh(auth, provider) {
      return { access, refresh, expires }   // 合并到旧账号上
    },

    // ④ 请求接管
    async loader(getAuth, provider) {
      return { baseURL, apiKey, headers, fetch }
    },

    // ⑤ 额度
    async usage(getAuth, provider) {
      return { plan, user, until, renew, balance, error, windows, resets, signIn }
    },

    // ⑥ 签到（文档漏了这个）
    async checkin(getAuth, provider) {
      return { outcome, credit, streak, message }
    },
  },

  // ⑦ 每账号的模型目录
  provider: {
    id: "xxx",
    async models(provider, { auth }) { ... },
  },

  // ⑧ 每个请求加头
  "chat.headers": async (input, output) => {
    output.headers["x-xxx-session"] = input.sessionID
  },
})
```

---

## 二、`auth.checkin` 完整契约

```js
auth.checkin(getAuth, provider) {
  outcome: "claimed"      // 刚签到成功
         | "done"         // 今天已经签过了
         | "ineligible"   // 这个账号不能参加
         | "inactive"     // 没有签到活动
         | "captcha"      // 厂商要验证码 —— 让用户去官方 App 手动签，永不解
         | "failed",      // 失败
  credit?: number,        // 给了多少积分
  streak?: number,        // 连续多少天
  message?: string,       // 显示给用户的话
}
```

### 调用规则（原文）

> magpie asks **once a Beijing day per account** while the user has it on,
> and **again later that day after a failure**; a hook that throws is a failure.
> Run in the account's scope, a token it renews is saved to that account.

| 规则 | 说明 |
|---|---|
| 时间口径 | **北京时间**（不是 UTC，不是太平洋时间）|
| 频率 | 每账号每天一次 |
| 重试 | 当天失败后还会再调 |
| 抛异常 | 等同 `failed` |
| 作用域 | 在账号的 scope 里，它刷新的 token 会存到该账号 |

### 状态文件

```
~/.config/magpie/plugin-checkin.json        （通用）
~/.config/magpie/workbuddy-checkin.json     （CodeBuddy 专用，magpie 内置）
```

格式：
```json
{
  "codearts|codearts": {
    "day": "2026-10-25",
    "at": "2026-10-25T17:16:46+08:00",
    "outcome": "done",
    "msg": "今天已领取"
  },
  "qoder-cn|qoder-cn": {
    "day": "2026-10-25",
    "outcome": "claimed",
    "credit": 100,
    "claimed": "2026-10-25T17:16:43+08:00"
  }
}
```

---

## 三、`auth.usage` 完整字段

```js
{
  plan?: string,                    // "Pro"
  user?: string,                    // 厂商那边这个账号的名字
  until?: string | number,          // 套餐到期
  renew?: "auto" | "off",
  balance?: string,                 // "$12.40"
  error?: string,                   // 替代 windows 显示

  resets?: {
    count: number,
    until?: string | number,
    byWindow?: boolean,
    fiveHour?: number,
    weekly?: number,
    team?: boolean,                 // 团队套餐的，不是个人
    each?: [{                       // 每个还能用的重置
      until?: string | number,      // 无 = 永不过期
      window?: "fiveHour" | "weekly",
    }],
  },

  windows?: [{
    name: string,
    used: number,                   // ⚠ 必填。百分比 0-100，超额时 >100
                                    // 它是**路由排序输入**，不是只给进度条用的：
                                    // 缺了 magpie 归一成 0 = 「满额」，会把一个
                                    // 耗尽的账号顶到路由队首（见第十一节）
    resetsAt?: string | number,
    resetSecs?: number,
    display?: string,               // "370 / 1000 credits"
    amount?: number,
    limit?: number,
    unit?: string,                  // "credits"
    span?: number,                  // 窗口时长（秒）
    model?: string,                 // 只统计 id 含该词的模型
    models?: string[],              // 精确的 id 列表
    notModels?: string[],           // 除这些之外
    aside?: boolean,                // true: 用光不影响账号
    runsOutAt?: string | number,    // 剩余额度什么时候失效
    runsOut?: number,               // 失效时损失多少
  }],

  signIn?: "expired" | "kept" | "renewed",
}
```

**时间可以是 ISO 字符串、秒、毫秒。**

### ⚠⚠ 三条「写错不报错」的窗口规矩

这三条都是**静默失败**：钩子不抛异常、magpie 也不报错，只是卡片悄悄变成
「剩余额度未知」，或者算出一个没有意义的百分比。实测撞过，代价是整个额度区报废。

#### ① `aside: true` 的窗口不进路由 —— 但「丢占比」的元凶是**没有 `used`**，不是 `aside`

> ⚠ 2026-10-29 更正（issue [#468](https://github.com/magpie-community/plugins/issues/468)，magpie v0.1.1934）：
> 判断一条窗口「有没有占比」**只看 `used`**。没有 `used` 的窗口是 `Text`，路由不计入 ——
> 与 `aside` 无关；而且 magpie ≥ `1390aa458` 起，有 `amount` + `limit` 却没有 `used` 的窗口会用
> `amount / limit` 推算占比。本文原来把两件事混成了一件，下面按更正后的机制重写。

这条最贵，因为它有两个后果，而只有第一个显眼。

先看**显示层**的坑：`aside` 的含义是「用光也不影响账号」，它本来就没有上限、没有周期。
给了 `amount`/`limit`，magpie 会把它当成**一条真额度去算占比**：

```js
quotaCount(w){ if (!(w.limit > 0)) return w.display || ""; … }
```

而「总量 = 当前余额」这种假总量，算出来永远是「剩余 100%」——数字看着漂亮，
含义是错的（这也是市场现有插件被诟病的点）。

```js
// ❌ 假占比：分母就是"剩余"本身，永远 100%
{ name: "积分余额", used: 0, amount: 0, limit: 6291, aside: true }

// ✅ 只想展示一行文字（这个号还有别的窗口参与路由）：只给 display
{ name: "积分余额", used: 0, aside: true, display: "6,291 积分", unit: "积分" }
```

**再看路由层的坑（2026-10-28 真机踩中，代价是整个号在路由里消失）：**

`aside: true` 的窗口，和 `used` 缺省后被判成的 `Text` 窗口，**都会**被 `allowanceOf()`
整条跳过（`internal/provider/routing.go`）—— 两个条件独立，与有没有 `amount`/`limit` 无关：

```go
for _, w := range ws {
    if w.Aside || w.Text { continue }        // ← 整条跳过
    ...
}
if len(a) == 0 { return nil, false }          // ← 一条不剩 ⇒ 这个号 Known = false
```

⇒ **一个账号的窗口全标了 `aside`，它在路由页就是「剩余额度未知」，
而且一律排在已知账号之后。** 这不是「不参与排序」，是「这个号在路由里不存在」。

**官方文档逐字（`docs/subsystems/provider-plugins.md`，issue #3650）：**
> An account whose windows all tell no share has no allowance, so routing counts it
> not known ... as one never read, rather than as the one with all of it left.
> A window that says `used: 0` is a reading at 0, as before.

**所以两种用法，别搞混：**

| 目的 | 写法 |
|---|---|
| 一行文字要展示，**且这个号还有别的窗口参与路由** | `aside: true` + `display` ✅（**别给 `amount`/`limit`**：分母是余额本身，永远「剩余 100%」） |
| 这个号**只有**这一条额度信息 | **不要标 `aside`**：给 `used` + `limit`（哪怕百分比没有信息量），否则路由里没有这个号 |

**判据：** `curl -s http://127.0.0.1:3425/v1/magpie/trace`，看这个 provider 的
`known` 是 `true` 还是**字段缺失**。缓存侧看 `~/.config/magpie/quotas.json` 的
`spans`：`[{}]` = 没标，`[{"aside":true}]` = 还标着。

#### ② `resetsAt` / `runsOutAt` 必须是 **ISO 字符串或数字**

厂商接口常回 `"2026-10-28 23:59:59"`（空格分隔、无时区）。**直接塞进去，
magpie 解析不了，整条窗口会被跳过** —— 表现是卡片「剩余额度未知」，而
`usage()` 本身返回完全正常（有 plan、有 windows、没有 error），极难查。

```js
// ❌ 服务端原样格式
{ resetsAt: "2026-10-28 23:59:59" }

// ✅ 自己按本机时区拆字段再构造（别指望 new Date(str) 跨引擎一致）
{ resetsAt: new Date(2026, 9, 28, 23, 59, 59).toISOString() }
```

#### ③ 有「哪批额度先作废」的信息时，用 `runsOutAt` + `runsOut`，别拼进 `display`

`display` 是给「已用 / 总量」那种数字用的。把「185 分今天到期」拼进去，
magpie 只当普通文字显示，不会当作失效提醒处理。这两个字段专为这件事准备：

```js
{ name: "积分余额", used: 0, aside: true, display: "6,291 积分",
  runsOutAt: "2026-10-28T15:59:59.000Z", runsOut: 185 }   // 最早作废的那批
```

**判据**（三分钟自查）：

```bash
curl -s http://127.0.0.1:3425/v1/magpie/quotas
```

看这个 provider 的 `windows[0]`：
- 有 `display` 且 `text: true` ⇒ aside 窗口被正确识别成文本
- 有 `runsOutAt`（ISO 形式，如 `2026-10-28T15:59:59Z`）⇒ 失效提醒生效
- 卡片显示「剩余额度未知」⇒ 八成是 ② 的时间格式，或窗口整个不合法

---

## 四、登录的陷阱

### 陷阱 1：`authorize()` 里不能等用户

```js
// ❌ 死锁
async authorize() {
  const token = await waitForUserToLogin()   // 这里等 = magpie 双向死锁
  return { type: "success", access: token }
}

// ✅
async authorize() {
  const flow = startLoginFlow()
  return {
    url: flow.url,
    method: "auto",
    callback: async () => {                   // 真正等登录的是这里
      const token = await flow.result
      return { type: "success", access: token }
    },
  }
}
```

### 陷阱 2：`inputs` 只在有 `prompts` 时传入

> the inputs go only to a method that asks something... an object with none
> is how its CLI calls, and a plugin told so asks its questions on the terminal

```js
// 没有 prompts → 收到 undefined
// 有 prompts   → 收到 { region: "cn", team: "t-xxx" }
```

### 陷阱 3：`opened: true` 防止开两次页面

```js
// Grok Build 的 `grok login` 在 macOS/Windows 上自己开了页面
// magpie 再开一次 → 用户看到两个一样的窗口
return { url, opened: true }
```

### 陷阱 4：`single: true` 只允许一个账号

```js
auth: {
  single: true,     // 再登录会替换而不是新增
}
```

### 陷阱 5：多步问答必须用 `ask()`，不是 `prompts` 数组

`prompts` 是**静态**的：magpie 读它列问题，一次问完。要让「邀请码 → 主登录的问题」串起来，
method 上还要再加一个 `ask(inputs)`，每次返回**下一个**问题，问完返回 `null`：

```js
{
  type: "oauth",
  label: "… 邀请码",
  get prompts() { return [invitePrompt()] },        // 面板列表要靠它
  async ask(inputs) {
    if (!hasOwn(inputs, "invite")) return invitePrompt()
    if (!hasOwn(inputs, "region")) return regionPrompt
    return null                                      // 问完了
  },
  async authorize(inputs) {
    saveInvite(inputs.invite)                        // 保存策略
    return await mainMethod.authorize(inputs)        // 直接接主登录
  },
}
```

契约：`internal/plugin/providers.go` 的 `NextPrompt()` → 插件 `prompt` 钩子 → `method.ask(inputs)`。
CLI 与 GUI 都走它（`internal/cli/plugins_cli.go:453`、`internal/gui/plugins.go:746`）。

⚠ **同时保留 `get prompts()`**：只给 `ask` 不给 `prompts`，那条登录方式在列表里看起来像什么都不问。
⚠ `authorize` 里**复用主登录的 authorize**，不要复制一份 callback —— 复制必然只改一边。
⚠ 判断「问过没有」用 `Object.prototype.hasOwnProperty.call(inputs, key)`，
   不要用 `inputs[key] !== undefined`：用户填了空字符串也是「问过了」。

---

### 陷阱 6：`authorize()` 的 `account` 恒为 `new` —— 插件拿不到是哪张卡

宿主的 `authorize` 命令确实带 `account` 参数（`host.js` 的
`authorize({ provider, method, inputs, account, proxy })`，由 `signInKey()` 决定写哪个
key），但 **magpie 自己从不传账号键**：

- GUI 的「Sign in again」/「Add account」→ `internal/provider/pluginsignin.go:121`
  `plugin.Authorize(ctx, id, method, inputs, plugin.NewAccount)`
- CLI `magpie plugin login` → `internal/cli/plugins_cli.go:492`，同样 `plugin.NewAccount`
- 账号名只作为 `SignInOptions.User` 到 Go 侧，唯一用途是 `pluginUsing(saved, user)`
  判断「登录的是不是正在用的那个账号」，**不会进插件**

`signInKey(provider, "new")` 走 `freshKey(provider)`，`inScope(provider, 新 key)` 里调
`m.authorize(...)`；插件客户端也没有 `auth.get`（只有 `set`/`remove`），`getAuth` 只传给
`loader` / `models` / `usage` / `checkin`。

⇒ **不要在 `authorize()` 里假设能知道用户点的是哪张卡**。要「按账号」的入口只能用
`usage().signIn = "expired"` 借 magpie 自带的「Sign in again」按钮（它同样拿不到账号，
只能按 provider 级状态判断），或在登录说明/落地页里放一个通用入口。

（2026-10-30 核对：本地 v0.1.1775 源码与安装版 0.1.2188 内嵌 `host.js`/`app.js` 一致。）

---

## 四之二、登录的三种形态（决定弹不弹浏览器）

| 形态 | 形状 | 弹窗口？ | 前提 | 实测结论 |
|---|---|---|---|---|
| **A 浏览器 OAuth** | `{ url, method: "auto", callback }`，callback 里等 loopback 回来 | **会** | 无 | 最通用；厂商的登录页、滑块、验证码都交给厂商自己 |
| **B 本机客户端导入** | `{ url, opened: true, method: "auto" }` + callback 里读客户端文件 | **不会** | 用户已装并登录过官方客户端 | 最省事；见 [`src/desktop-import.mjs`](./src/desktop-import.mjs)（DPAPI + AES-GCM） |
| **C 内置验证码（headless）** | 后台起 headless 浏览器走登录页，`method: "code"` 让用户只填验证码 | **不会** | 本机有 Chromium 内核浏览器 | **不建议默认提供**：滑块/风控/限流都要自己扛，实测同一出口 IP 连续发码会被静默拦下（页面停在发送页、不报错） |

**选择顺序**：B（如果有客户端）→ A（默认）→ C（只在 B 不可用且厂商没风控时）。

`auth.methods` 里可以同时给出 A 和 B：B 的 `opened: true` 让 magpie 不再开页面，
整个登录就是「点一下 → 读文件 → 成功」。

---

## 五、`auth.refresh` 的语义

```js
async refresh(auth, provider) {
  // 返回值 **合并** 到旧账号上（与 client.auth.set 的整体替换不同）
  return { access, refresh: newRefresh ?? auth.refresh, expires }
}
```

### 运行时机

- OAuth 账号的 `expires` 距现在 < `refreshLead` 时
- 在 loader / provider.models / auth.usage / 请求 **之前**

### 串行化

> Requests that find the token due wait for one renewal, so a vendor that
> spends a refresh token once never sees it twice. They wait up to 15 seconds.

**一次性 refresh_token 的厂商（如 CodeBuddy）不会被并发用两次。**

### 失败处理

| 情况 | magpie 行为 |
|---|---|
| `throw Object.assign(e, { signIn: "expired" })` | 标记账号，不再重试直到重新登录 |
| 其它错误 | 30 秒后重试 |
| 返回 `undefined` | 保持原样，不续期 |

### 不续期的情况

> An account with `expires` 0 or none is never renewed.

**`expires` 为 0 或不存在的账号永不续期。**

---

## 六、`loader` 返回的四个字段

```js
{
  baseURL,    // 请求去哪（优先于模型的 api 和 provider 的 api）
  apiKey,     // 按 npm 包自动加头：见下表
  headers,    // 每个请求都加
  fetch,      // 真正的请求函数
}
```

### apiKey 的发送方式（magpie 自动处理）

```js
// 契约源码原文
function sdkHeaders(npm, key) {
  if (!key) return {}
  if (npm === "@ai-sdk/anthropic" || npm === "@ai-sdk/google-vertex/anthropic")
    return { "x-api-key": key }
  if (npm === "@ai-sdk/google")
    return { "x-goog-api-key": key }
  return { authorization: `Bearer ${key}` }
}
```

### 请求头的设置顺序（后者覆盖前者）

```
1. sdkHeaders(apiKey)
2. loader.headers
3. gateway 的请求头
4. chat.headers 钩子加的
```

### `fetch(input, init)` 收到什么

- `input`：完整 URL
- `init.method`：通常 POST
- `init.body`：该 API 形状的 JSON 字符串（非 UTF-8 时是 bytes）
- `init.signal`：agent 放弃时 abort

**必须返回 Response。** 状态码、头、body 原样透传。

**改写流式 body 时要去掉 `content-length` 和 `content-encoding`。**

---

## 七、失败处理的层次

| 情况 | 做法 | magpie 的行为 |
|---|---|---|
| 模型不存在 | 返回 **404** + 错误 JSON | 只搁置**这个模型** |
| 登录被拒 | 401 或 `signIn: "expired"` | 标记**这个账号** |
| 这个 401 是别的事 | 响应头 `X-Magpie-Sign-In: kept` | 不标记 |
| 已续期 | 响应头 `X-Magpie-Sign-In: renewed` | 清除标记 |
| 限流 / 5xx | 原样透传 | 自动换账号或模型 |
| 插件内部错误 | 抛异常 | 请求失败，故障转移继续 |

**尽量用该 API 自己的错误形状回答**，agent 才能显示供应商的原始消息。

> **上面这张表只回答「用哪个状态码」，不回答「错误怎么说清楚」。**
> 每条错误还必须带一个稳定的 `code`（机器读）和一段有信息量的 `message`（人读），
> 否则宿主只能拿到一个数字、用户只能看到「服务异常」。
> 词表、流式错误帧的形状、最小实现模板都在 [`ERROR-CODES.md`](./ERROR-CODES.md)；
> 形态由 `node scripts/check-error-codes.mjs <插件目录>` 卡门（已并入 `npm run check`）。

---

## 八、账号标识（决定卡片显示什么）

### 三级回退（契约源码 `whoOf`）

```js
function whoOf(a) {
  return a?.accountId ?? a?.metadata?.email ?? a?.email ?? ""
}
```

**登录成功时返回的字段决定卡片显示：**

```js
return {
  type: "success",
  refresh, access, expires,
  accountId: "user@example.com",   // ← 首选
  uid: "0d1606bf-...",             // ← 区分同名账号
}
```

| 字段 | 作用 |
|---|---|
| `accountId` | 卡片显示的账号名 |
| `metadata.email` | 次选 |
| `email` | 再次选 |
| `uid` | 厂商自己的 id，区分同名账号（issue #413）|

### `accountId` 是名字，`uid` 是身份 —— 别拿内部 ID 当名字

`accountId` 只放**人扫一眼就能分辨**的东西：打码手机号（`138****8000`）、邮箱、昵称。
厂商的内部 ID（`iam::<domain>:user:<name>`、`urn:…`、uuid、裸 hash、华为的 `hw0000…`）
不是名字，它们进 `uid`。

**写错的代价是永久性的**：`auth.refresh` 返回的字段会**合并**进旧记录，而插件自己的
落盘（`persistCredential`）通常又会优先保留已有的 `accountId` —— URN 进去一次，卡片就再也
变不回来。用户看到的是三行 `iam::00000000…:user:hw0000…`，只会以为「插件显示乱码」。

```js
import { resolveAccount } from "./src/account-name.mjs"

// 登录成功：名字给人看，身份给宿主去重
const { phone, name, urn } = await readWhoSignedIn(cred)   // 你的接口
return { type: "success", refresh, access, expires, ...resolveAccount({ phone, name, urn }) }
// → { accountId: "138****8000", uid: "iam::00000000000000000000000000000000:user:hw000000000000000" }
```

三条判据：

1. 手机号一律**打码**（`maskPhone`：`0086-…` / `+86 …` / 裸号 / 已打码的值都认）。
2. 像内部 ID 的值**不当名字**（`looksLikeIdentifier`：含 `::`、`urn:`、uuid、裸 hash、`hw…`）。
   名字全取不到就**不给 `accountId`**，让宿主回退供应商名 —— **绝不拿 URN 顶上**。
3. **老记录要能改**：续期时把 `accountId` 重新算一遍，并在 `refresh` 的返回值里带上；
   magpie 会用它覆盖旧记录（`host.js`：`if ("refresh" in result) setAuth(key, { …, ...extra })`）。
   只改登录路径的话，已登录的账号会永远停在旧名字上。

> 真实事故：CodeArts 0.2.4 从 refresh token 的 `user_profile` 取 `principal_urn` 当 `accountId`，
> 三个账号显示成三串 ID；0.2.5 改成登录后读一次华为云 IAM 的手机号（`GET /v3.0/OS-USER/users/
> {principal_id}` → `user.phone`），打码成 `138****8000`，URN 改走 `uid`。

### 没有 accountId 时

```js
// hintOf tells an account with no id from another: the end of its key.
function hintOf(a) {
  return a?.type === "api" && typeof a.key === "string" && a.key.length >= 12
    ? a.key.slice(-4) : ""
}
```

**API key 类型没有 accountId → 卡片显示 key 的最后 4 位。**

### 同名账号自动合并（`settle`）

```js
// settle keeps a sign-in just saved at key once: one to an account already
// signed in (the same account id and, where both have one, the same uid,
// else the same secret) replaces that one's and goes.
```

判定顺序：
1. `accountId` 相同 **且** `uid` 相同（两边都有 uid 时）→ 替换旧账号
2. 都没有 accountId，但 secret 相同 → 替换
3. 否则 → 新增账号

**所以重复登录同一账号不会产生重复条目。**

### 账号在存储里的 key

```js
// accountsOf are the keys provider's accounts are kept under, the one under
// its own id first.
function accountsOf(all, provider) {
  return Object.keys(all)
    .filter((k) => k === provider || k.startsWith(provider + "#"))
    .sort(...)
}
```

```
第一个账号  →  provider
第二个账号  →  provider#a1b2c3
第三个账号  →  provider#d4e5f6
```

---

## 九、图标与并发（两级回退）

### 图标（契约源码 `iconOf`）

```js
function iconOf(a) {
  const ok = (v) => {
    const s = typeof v === "string" ? v.trim() : ""
    // data URI 超过 1MB 不携带
    return s.length <= 3 << 19 && /^(https:\/\/|data:image\/)/i.test(s) ? s : ""
  }
  // ① auth 钩子的 icon 优先
  const own = ok(a.auth.icon)
  if (own || !a.target) return own
  // ② 否则读 package.json 的 magpie.icon
  return ok(readJSON(path.join(dir, "package.json"))?.magpie?.icon)
}
```

**优先级：`auth.icon` > `package.json` 的 `magpie.icon`**

**约束：**
- 必须是 `https://` 或 `data:image/` 开头
- 大小 ≤ 1 MB（`3 << 19` = 1,572,864 字节）
- SVG、PNG 都行

### 并发（契约源码 `concurrencyOf`）

```js
function concurrencyOf(a) {
  const ok = (v) => (Number.isInteger(v) && v > 0 ? Math.min(v, 1000) : 0)
  const own = ok(a.auth.maxConcurrency)
  if (own || !a.target) return own
  return ok(readJSON(path.join(dir, "package.json"))?.magpie?.maxConcurrency)
}
```

**优先级：`auth.maxConcurrency` > `package.json` 的 `magpie.maxConcurrency`**

**范围：1-1000 的整数。** 用户自己设的会覆盖它。

### 插件自己的图标：`magpie.icon` —— 和上面那个 `iconOf` 不是一回事

上面讲的 `iconOf` 管的是**供应商卡片**。**插件卡片**（插件列表那一行、插件详情页左上角）
走的是另一条路，源码 `internal/plugin/market.go`：

```go
// InstalledIcon is the picture the installed plugin spec's package.json
// gives in magpie.icon, as ownIcon takes one: the plugin's own, for its
// row, apart from those its providers give themselves in the auth hook (#1775).
func InstalledIcon(spec string) string {
	b, _ := os.ReadFile(filepath.Join(Target(spec), "package.json"))
	var p struct {
		Magpie struct {
			Icon string `json:"icon"`
		} `json:"magpie"`
	}
	// ...
}
```

⚠ **`auth.icon` 到不了插件卡片。** 只写 `auth.icon` 的后果：

| 位置 | 有图标吗 |
|---|---|
| 供应商列表那一行 | ✓ |
| 用量概览的卡 | ✓ |
| **插件列表那一行** | ✗ 灰方块（回退到默认图） |
| **插件详情页左上角** | ✗ 灰方块 |

⇒ **两个都要写。** 内容一样就抄两份：

```json
{
  "name": "Magicrew",
  "magpie": {
    "icon": "data:image/png;base64,iVBORw0KGgo...",
    "maxConcurrency": 4
  }
}
```

同一份 data URI 也放进 `auth.icon`，两处各一份。

## 九之三、卡片上的徽章从哪来

插件行上除了名字和版本，还会出现几类 chip。哪些插件能给自己挣到，哪些挣不到：

| 徽章 | 数据源 | 插件能控制吗 |
|---|---|---|
| `已是最新` / `有新提交` / `v{x} out` | npm 版本、git HEAD，magpie 自己比 | 间接（发版即可） |
| `已自动更新` | magpie 自己更新过 | — |
| `供应商` / `Request hook` / `中间件` / `页面` | 插件导出里带了什么钩子 | ✓ 有钩子就有 |
| **`承载 {names}`** | `moved`（内置订阅迁到插件的）+ `serves`（**它注册的 provider 名**） | ✓ **就是你的供应商名字**（magpie ≥ 0.1.1744） |

### `承载` 现在由宿主派生（v0.1.1744 起）

`766356c` 之后（issue [#3902](https://github.com/yetone/magpie/issues/3902)），
`internal/gui/plugins.go` 在 `moved` 之外再填一份 `serves`：

```go
j.Moved = provider.MovedOnto(e.Spec)          // 内置订阅迁过来的
j.Serves = servesBeside(j.Moved, provs[e.Spec])  // 它自己注册的 provider 名
```

`servesBeside` 的规矩（`internal/gui/plugins.go`）：

- 取每个注册 provider 的 `name`（空则退回 `id`），每个一次，大小写不同算重名；
- `moved` 里的 id 跳过 —— 页面已经按内置名画了，不重复；
- **`moved` 为空且只注册了一个 provider ⇒ 返回 nil**，不画徽章（行标题已经说了）；
- 前端把 `moved` 的名字和 `serves` 拼成一个 chip：
  `承载 {moved 的名字 + serves}`；tooltip「… 正由此插件代替内置运行」**只在 `moved` 非空时**才挂。

所以第三方插件现在**能**挣到这个徽章了 —— 徽章内容就是你的供应商名：

| 你的包 | 卡片 |
|---|---|
| 一个 provider | 无徽章 |
| 两个 provider，品牌名不同 | `承载 超级麦吉、MagiCrew` |
| 两个 provider，共用一个品牌名 | `承载 Qoder 国际版 (qoder.com)、Qoder CN`（名字里得带站点，magpie 内置名就这么写） |

> ⚠ 曾经草案里有个 `magpie.carries` 字段（#3902 的 option 1），从未随任何 magpie 发布：
> 上游选了派生。写了不报错，只是没人读；`scripts/check.mjs` 会提醒删掉。
> 插件关闭时（`off`）不画这个 chip，和别的 chip 一样。


---

## 九之二、插件名（卡片标题显示什么）

### 先把三个「名字」分清

这张表把最常混的三件事钉死：

| 你写的 | 在哪 | 显示在哪 |
|---|---|---|
| `package.json` 的 `name` | 包根 | **插件卡片标题** —— 插件列表那一行、详情页标题。链路：bun 按它写 `plugins/package.json` 的依赖键 → magpie 反查键名当标题 |
| `config.provider[id].name` | 插件代码 | **供应商列表那一行**（`magicrew (超级麦吉, 27 models)` 里的「超级麦吉」） |
| `registry-entry.json` 的 `name` | 仓库根（提交给 registry） | 市场条目里的显示名 —— **不是卡片标题** |
| 仓库名 | GitHub | 只进链接（`repository`、源码按钮），不参与任何显示 |

拿 `magpie-magicrew-auth` 举例：

```
package.json        name: "Magicrew"      → 插件卡片标题「Magicrew」
config.provider     name: "超级麦吉"       → 供应商列表「超级麦吉」
                    name: "MagiCrew"      → 供应商列表「MagiCrew」
仓库名               magpie-magicrew-auth  → 只出现在「源码」按钮的链接里
```

⚠ **「插件叫什么」和「供应商叫什么」是两件事。** 一个包两个供应商时，卡片标题只有一个
（包的 `name`），供应商名有两个。把站点名写进包的 `name` 会让卡片变成
「超级麦吉 / MagiCrew」这种缝合物。


### 结论先说：插件名**没有** `displayName`

magpie 不读 `package.json` 的 `name`、也不读任何自定义显示字段来当卡片标题。标题来自
`plugin.Name()`（`internal/plugin/store.go`）：

```go
func Name(spec string) string {
	if IsPath(spec) { return spec }                    // 路径安装 → 路径
	if IsGit(spec) {                                   // git 安装
		if n := gitName(spec); n != "" { return n }    //   → dependencies 的键名
		return spec                                    //   → spec 原文
	}
	at := strings.LastIndex(spec, "@")                 // npm 安装 → 去掉 @version
	if at > 0 { return spec[:at] }
	return spec
}
```

| 安装方式 | 卡片标题 |
|---|---|
| `magpie plugin add ./my-plugin` | 那个路径 |
| `magpie plugin add github:owner/repo` | **`plugins/package.json` 里 dependencies 的键名** |
| `magpie plugin add my-npm-package` | 包名（去掉 `@version`） |

### git 安装：名字 = dependencies 的键名

`gitName()` 的实现就是反查：

```go
for name, s := range pj.Dependencies {
	if s == spec { return name }   // ← 键名就是显示名
}
```

**键名同时是 `node_modules` 下的目录名**，所以改名必须三处同步，漏一处就加载失败。

### 改名的完整步骤（实测）

以 `github:owner/repo` 改叫 `Loomy` 为例：

```
~/.config/magpie/plugins/
├── package.json     ┐
├── bun.lock         ├─ 三处都要把旧键改成新名
└── node_modules/    ┘
    └── Loomy/       ← 目录名必须跟着改
```

```bash
cd ~/.config/magpie/plugins

# 1. package.json：把键改成想显示的名字
#    "magpie-plugin-loomy-auth": "github:owner/repo"
#    → "Loomy": "github:owner/repo"

# 2. bun.lock：同样换键（两处：workspaces.dependencies 和 packages）
#    "magpie-plugin-loomy-auth": "github:..."  → "Loomy": "github:..."
#    "magpie-plugin-loomy-auth": [...]          → "Loomy": [...]

# 3. node_modules 目录改名
mv node_modules/magpie-plugin-loomy-auth node_modules/Loomy
```

然后重启 magpie。

**只改 1、2 不改 3 会报：**

```
plugin github:owner/repo didn't load:
  Error: no such plugin: ...\plugins\node_modules\Loomy
```

**已经装好之后改名，不需要重新下载。** 三处键名一致、目录存在即可。

### 陷阱

⚠ **不要试图靠改仓库名来改名。** 仓库名不影响显示（git 安装看的是 dependencies 键），
改仓库名只会让所有已安装用户的 spec 失效。

⚠ **`magpie plugin add` 会覆盖你手改的键名。** 每次 `add` / `update` 都由 bun 重新写
`package.json`，键名回到包自己的 `package.json` 里那个 `name`。所以**正路是改包内的
`name`** —— 改完装出来就是那个名字，再也不用管（实测见 [UPDATING.md](./UPDATING.md)）；
不想改 `name` 才退回去手改，接受每次更新后重改。

⚠ **npm 安装无法改名。** 标题就是包名，只能通过改包名（重新发布）实现。

### 卡片上的其他文字来自哪

| 位置 | 来源 |
|---|---|
| 标题 | 上面说的 `plugin.Name()` |
| 标题下一行 | 安装 spec（`github:owner/repo` 或包名） |
| 「版本」 | 已装包自己的 `package.json` 的 `version` |
| 「版本」后面那串 | **只有 git 源有**：已装那份代码的 **commit 短 sha**（`plugin.ShortCommit`）|
| 「更新于」 | npm registry 的发布时间，或 git commit 的时间 |
| 「npm ↗ / 源码 ↗」按钮 | npm 安装显示 npm，git 安装显示源码（`package.json` 的 `repository` 决定链接） |
| 介绍正文 | **README.md 的内容**（见第十章） |

**为什么 git 源要补一个 commit。** 那边「版本」不是可靠的标识 —— 同一个 `0.1.14`
可以对应任意多个 commit（改了代码、不发 npm，包内 `version` 就不会动）。所以 magpie
把短 sha 跟在版本号后面，那一串才是「你装的到底是哪份代码」：

```
Loomy  0.1.14 c2aacc2      ← 版本号 + 本机装的那次 commit
```

短 sha **从哪读**（`internal/plugin/gitrev.go` 的 `GitCommit()`，按顺序）：

1. `node_modules/<目录名>/.bun-tag` —— bun 写的，形如 `MYCF711-magpie-loomy-auth-c2aacc2`，取最后一段
2. 否则读 `plugins/bun.lock` 的 `"<名>": ["<名>@…#<sha>"…]`

⚠ 第 2 条的正则**要求键名与值首段同名**。改过别名的依赖
（`"OfficeAce": ["officeace-auth@…#…"]`）在那里**匹配不上** —— 所以现役路径其实是
`.bun-tag`；那个文件没了，这串也就没了。

**它不是「有更新时才有」。** `internal/gui/plugins.go` 里只有一个条件：

```go
if plugin.IsGit(e.Spec) {
    j.Commit, j.Head = plugin.ShortCommit(plugin.GitCommit(e.Spec)), plugin.ShortCommit(plugin.GitHeadCached(e.Spec))
}
```

git 源**总是**填 `Commit`（已装）和 `Head`（远端最新），npm 源两个都不填。
⇒ **那串只在 git 源出现，而且在插件侧去不掉** —— 想让版本位置干净，只有改用 npm 源。

同一套符号解释了两件事：

| 现象 | 机制 |
|---|---|
| 改了代码、推上去，version 没变，界面也提示有新版本 | git 源比的是 **commit**（`GitBehind` / `SameCommit`），不是 version —— 文案 `已安装 {have}，{repo} 已到 {head}`、`{head} 是 {repo} 的最新提交` |
| 同一版本号，两串却不一样 | 两个仓库各自的 commit 不同；光看 version 分不清 |

⚠ **npm 源没有这个兜底** —— 那边比的只有 `version`，所以改了代码**必须 bump**，
否则用户看不到任何更新提示（见 [UPDATING.md](./UPDATING.md)）。

⚠ **已安装卡片的元数据是有限的**：只显示版本、更新于、按钮和 README 摘要。
**publisher、周下载量、license、stars 只在「发现」面板的卡片上显示**，不在已安装列表里
（`internal/gui/plugins.go` 的 `pluginEntryJSON` 没有传给这些字段）。想让某条信息出现在
已安装卡片上，**写进 README**。

---

## 十、卡片介绍页（不是钩子）

**magpie 用 npm 包的 README 渲染插件卡片的介绍正文。**

官方文档原文：
> **README.** A plugin's page in magpie shows its npm README. Say what it signs in to,
> how, where the sign-in is kept, and which models it has.

**所以 README 要写清楚四件事：**
1. 签入什么服务
2. 怎么登录
3. 登录态存在哪
4. 支持哪几家发行商（`DeepSeek / GLM / GPT`），各家只列最新 / 热门一两行

> 官方原文是「which models it has」，但**别写成「支持 N 个模型」** —— 平台目录 ≠ 计费清单，
> 那个数还要跟着上下架维护。写法见
> [README-TEMPLATE](./README-TEMPLATE.md) 的「模型」段：发行商开头，表格留最新 / 热门，
> 全量由 `magpie plugin list` 出。

### 卡片上其它元素（全部自动）

| 元素 | 来源 |
|---|---|
| 版本号 | `package.json` 的 `version` |
| 许可证 | `package.json` 的 `license` |
| 「npm ↗」链接 | `package.json` 的 `name` |
| 「源码 ↗」链接 | `package.json` 的 `repository` |
| 更新时间 | npm 的发布记录 |
| 下载量 | npm 统计 |
| 「已登录」绿勾 | 有 auth 记录 |
| 「非官方插件」警告 | GitHub topic 安装的会自动标 |

### provider 信息的完整组装（契约源码）

```js
{
  spec: a.spec,
  name: p.name,
  npm: p.npm ?? "",
  api: p.api ?? "",
  methods: methods(a.auth),
  single: a.auth.single === true,
  icon: iconOf(a),
  usage: typeof a.auth.usage === "function",      // ← 有无 usage 钩子
  checkin: typeof a.auth.checkin === "function",  // ← 有无 checkin 钩子
  options: optionsOf(a.auth),
  decide: p.decide === true,
  searches: p.searches === true,
  maxConcurrency: concurrencyOf(a),
  signedIn: keys.length > 0,
  authType: first?.type ?? "",
  accountId: whoOf(first),
  fellBack: keys.length > 0 && !!p.fellBack,
  listError: ...,
  accounts: keys.map((k, i) => ({
    key: k,
    type: stored[k]?.type ?? "",
    accountId: whoOf(stored[k]),
    hint: hintOf(stored[k]),
    models: ...,
    fellBack: ...,
    listError: ...,
  })),
  models: [...],
}
```

**`usage: typeof a.auth.usage === "function"` —— magpie 直接探测你有没有这个钩子。**

---

## 十一、`usage` 字段怎么变成你看到的进度条

```js
windows: [{
  name: "积分",                          // 进度条上方的标签
  used: 62.7,                            // 已用百分比（0-100，超额 >100）
  display: "2,131.63 / 3,400 积分",       // 数字显示
  amount: 2131.63,                       // 已用
  limit: 3400,                           // 总量
  unit: "积分",                          // 单位
  resetsAt: "2026-11-23T00:00:00Z",      // 重置时间
  aside: false,                          // 用光是否停账号
}]
```

渲染结果：

```
积分  ████████░░░░  2,131.63 / 3,400 积分 · 剩余 62.7%
```

**如果只给 `used` 不给 `display`/`amount`/`limit`，就只有一个光秃秃的进度条。**

**`aside: true` 的窗口用光不会停账号**（比如赠送积分），
magpie 会把它显示成「附加额度」。

### ⚠⚠ `used` 是必填，而且它决定路由，不只是画条

这是本节最要紧的一条，踩过的人付出了很实的代价。

magpie 归一化时是这么取的（宿主源码原文）：

```js
used: Math.max(0, num(w?.used)),   // past 100 when overspent
```

**`num(undefined)` 是 0** —— 于是「插件没上报 `used`」和「插件上报了 0%」
在宿主眼里完全一样。而这个值还被拿去排序账号：

```js
const group = (w) => w.used >= 98 ? "spent" : w.used >= 90 ? "low" : "fine"
```

`spent` 的账号在智能路由里的解释是 *"all but used up, it answers only when
nothing else can"* —— **排到最后**。

所以漏一个 `used` 会同时造成两件坏事：

| 后果 | 机制 |
|---|---|
| 卡片显示「剩余 100%」 | 设置里「显示剩余」时 `100 - used`，`used=0` ⇒ 100% |
| **耗尽的账号被排到队首** | `used=0` ⇒ `fine` ⇒ 排在真在用的账号前面 |

实测（2026-10-26，本机三天路由日志）：一个余额 0 的账号因为插件没上报
`used`，在其所在路由组被选中 **256 次里占 255 次**，11 次请求被上游以
「余额不足」拒掉。补上 `used` 后同一个账号从 **3/13 → 13/13**，并被 magpie
按窗口休息到下一个结算日，之后再没被选中。

**每条窗口都必须给一个有限的数字**，包括这些边角情形：

```js
// 号被蹬空（两池皆 0）：合成一条 used:100 的窗口，让它沉底。
// 千万不要「什么都不画」—— 不画 = 没有参与路由的窗口 = 它继续排前面。
{ name: "今日额度", used: 100, display: "已耗尽" }

// 上限拿不到（厂商不下发 total）：别编一个 limit，但也别漏 used。
// 标 aside，让它只展示、不参与路由打分。
{ name: "今日额度", used: 0, aside: true, display: "1,234 剩余（上限未知）" }

// 没有上限、没有周期的池（永久积分/赠送额度）：aside，used 给 0。
// ⚠ 不要用 total = 剩余 伪造总量，那等于谎报占比。
{ name: "永久积分", used: 0, aside: true, display: "5,500" }
```

**判据：`windows` 里每一条都要有 `used`，且是 `Number.isFinite` 为真的数字。**
写完自己过一遍这四种情形：正常、耗尽、上限未知、只有永久池。
（`magpie-loomy-auth` 的 `tests/semantics.test.mjs` 就是这么锁的，可以参照。）

---

## 十一之二、`free`：让模型进「免费优先」那一档

模型条目上的 `free` 是布尔值，喂给 magpie 的 **Free first** 路由模式
（界面上叫「Free first」，路由 id 是 `free`）。契约原文：

> **Free first** — "Requests go to what costs nothing first: the models their
> vendor serves **at no cost to this subscription's allowance or credits**, in
> their listed order, and only when those can't answer to one that spends them."

路由解释也能印证：

```js
case "free":
  if (f.free) return t("Free first: {model} costs nothing on {who}, so it's tried before any that spends the allowance.")
  return t("Free first: every one that costs nothing is spent or resting, so {model} on {who}, which spends the allowance, is next.")
```

### ⚠ 判据是「花不花这份订阅的额度」，不是「倍率是否为 0」

这是最容易错的一处。实测（2026-10-26，本机 `plugin-providers.json`）：

```
rate === 0 的条目        51 条
  其中 free === true      13 条
  其中 free === false     38 条   ← 「套餐内不按次计费」，仍消耗套餐额度
```

那 38 条里包括 qoder 的 `ultimate` / `dfmodel` 等 —— 它们不按次计价，
但照样吃套餐配额，**不是免费**。若按 `rate === 0` 一刀切，会把一整批
套餐模型误标成免费，Free first 就会一直派到它们身上。

```js
// ❌ 错：把「不按次计费」当免费
free: m.rate === 0

// ❌ 也错：有倍率就一定是收费 —— `x0.0` 是 0 倍，等于不扣分
if (m.rate) { model.rate = m.rate; model.free = false }

// ✅ 对：只认厂商自己的声明
function isFreeModel(displayName, rate) {
  if (/免费/.test(String(displayName ?? ""))) return true      // 展示名写明「限时免费」
  return typeof rate === "string" && /^x0(\.0+)?$/i.test(rate.trim())  // 倍率 x0.0
}
```

**每个厂商的判据不同**，但都应当**来自厂商自己的说法**（展示名文本、
模型条目里的价格字段、或厂商文档），而不是从别的字段反推。

### 自查

```js
// 拿你的模型表跑一遍，确认该免费的确实是 true，不该的是 false
for (const [id, m] of Object.entries(models)) console.log(id, m.free, m.rate)
```

⚠ `free` 只影响 `free` 这个路由模式；`pace` / `usage` / `weight` 等不看它。
但它标错的后果很实：本该免费被优先派发的模型拿不到优先，或者反过来
把收费模型当免费一直用。

---

## 十一之三、模型条目上的全部字段（这一版的完整表）

> 2026-10-28 从 magpie **0.1.1763** 的二进制重新提取契约后补的。原来这一份漏了
> 6 个字段：`searches` / `decides` / `rateWas` / `fast` / `serviceTiers` / `modalities`。
> 漏了不会报错 —— 那些字段全是「不写就等于关掉某个能力」。

**模型级 · 顶层**（`cfg.models[<id>]`，或 `provider.models` 返回的每条）：

| 字段 | 形状 | 不写会怎样 |
|---|---|---|
| `id` / `name` | string | 必须；`id` 是 agent 用的那个 |
| `apiId` | string | 上游真正的模型 id 与 `id` 不同时才写（改名 / 加前缀时用） |
| `providerID` | string | magpie 内部填的，插件一般不用写 |
| `provider.api` / `provider.npm` | string | 不写就继承 provider 级 |
| `limit.context` / `limit.output` | number | 0 时 magpie 会去查模型库；别填猜的数字（见十六节） |
| `released` / `release_date` / `family` | string | 只影响排序与展示；**不写不会关掉能力** |
| `cost` | object | 只用于显示 |
| `variants` | object | 思考档位的可选值 |
| `rate` | number \| `"x0.03"` | 不给就不画倍率胶囊 |
| `rateWas` | 同上 | **折扣前倍率**（Qoder 的 `price_factor`）；折扣中时两个一起给 |
| `free` | boolean | 判据见十一之二，**不能从 rate 反推** |
| `fast` | boolean | `service_tier: priority` 时跑快（Cursor 那种）；不写就没有这档 |
| `serviceTiers` | array | 厂商按档位服务的那些档（#2514）；不写则只有默认档 |
| `decides` | boolean | **decision 模型**：从 agent 列表里隐藏，只作路由组的分类器用 |
| `searches` | boolean | 这个模型**自己会联网**（用平实的话问就行）；不写则 magpie 走它自己的搜索 |
| `headers` / `options` | object | 单模型额外的请求头 / 厂商专属参数 |

**模型级 · `capabilities` 下面**（宿主会把 `reasoning` / `attachment` / `toolcall` /
`modalities` 归到 `capabilities` 里，写的时候直接给这几个平字段，别自己嵌一层）：

> ⚠ **两个位置两种拼写，别混**：`provider.models` 返回的模型走 OpenCode 的 `Model` 形状，
> 里面是 **`toolcall`**（无下划线，[官方 `#provider`](https://usemagpie.ai/docs/zh/plugins#provider) 这么写的）；
> `config` 钩子里写死的静态模型用的是 **`tool_call`**（官方 `#quick` 的示例这么写的）。
> 写错位置的拼写不会报错，只会让「能不能调工具」这一项静默为假。

| 字段 | 形状 | 不写会怎样 |
|---|---|---|
| `reasoning` | boolean | 没有思考档位 |
| `attachment` | boolean | **不能收文件/图片** |
| `toolcall` | boolean | 不能调工具 |
| `temperature` | boolean | 不给则视为支持（`false` 才关） |
| `modalities.input` / `modalities.output` | `["text","image",…]` | **必须显式写全，`image` 要写成布尔值。** 省掉不等于「按 text 处理」：magpie 只认 `typeof input.image === "boolean"`（宿主按它算 `imageSaid`），没写就是**厂商未表态**，会退到 models.dev 按裸模型 id 投票 —— 同名模型只要在别家标过 `image`，这个实际收不了图的模型就会被当成能收图 |
| `interleaved` | boolean | 思考与正文交错输出（少数厂商） |
| `maxTokens` | number | 单次输出上限，与 `limit.output` 不同：这是「这一次」的上限 |
| `imageSaid` | boolean | **宿主自动算的**（`typeof capabilities.input.image === "boolean"`），插件不用写、写了也不读。想让 magpie 把「厂商说过」当真，就把 `input.image` 写成布尔值 |

> ⚠ **text-only 接口的写法（照抄）**：静态模型和 `provider.models` 返回的每条都要给全，
> 只写 `input: { text: true }` 等于没说。模板：
>
> ```js
> const TEXT_ONLY = { input: { text: true, image: false, audio: false, video: false, pdf: false } }
> // config 钩子里的静态模型
> { id, name, attachment: false, modalities: { input: ["text"], output: ["text"] } }
> // provider.models 返回的模型
> capabilities: { ..., attachment: false, input: { ...TEXT_ONLY.input, ...(base.capabilities?.input ?? {}) } }
> ```
>
> 实测代价（2026-10-29，magpie 0.1.1932）：CodeArts 8 个模型全部漏写 `image`，
> 四天里 161 次把截图直发上游，全部被 `The request model is not multimodal (InferHub.001001020.406)` 拒绝；
> 补上 `image: false` 后同一个请求改走识图模型描述，正常读出图内文字。

> `capabilities` 这一层最容易漏。漏了的效果是「模型能跑，但收不了图 / 不显示思考档」——
> 不报错，只是能力少一块。`python extract-contract.py` + `node scripts/contract-diff.mjs`
> 会把这类漏抄直接列出来。

**provider 级**（`config` 钩子里的 `cfg.provider[<id>]`）：

| 字段 | 形状 | 含义 |
|---|---|---|
| `searches` | boolean | 这个 provider 的上游**自己回答** web_search（Anthropic 或 Responses API 上，#2027）：客户的 `web_search` 原样发过去，不走 magpie 的搜索 |
| `decide` | boolean | 这个 provider 服务一个 **decision API**（System One），在 base `/systemone`，走它的 `fetch` |

> ⚠ 这两个 `searches` 不是一回事：provider 级是「上游整体会搜」，模型级是「这一条会搜」。
> 给错的后果是 magpie 把搜索请求发给一个不会搜的模型 —— 它不会报错，只会答非所问。

### 插件供图（`draw`）

magpie **0.1.1707 起**支持插件提供图像模型（0.1.1747 接入 SenseNova 的
`sensenova-u1.5-lite`）。三条判据同时在，才会出现在 Settings 的「图像生成」选择器里：

1. 模型 id 像画图的：`catalog.DrawsID` —— 含 `image` / `imagen` / `dall-e` / `flux` /
   `seedream` / `cogview` / `stable-diffusion` / `sdxl` / `wanx` / `kolors` / `hidream` /
   `banana` / `sensenova-u1` 之一
2. 它走 images API 而不是在 chat 里回图：`catalog.ImagesAPI` —— 同上列表减去
   `gemini-*-image` 与 `gpt-5-image`（那两类在 chat 里回图）
3. 这个模型所在的 npm 包是 `@ai-sdk/openai-compatible`

满足后，magpie 把请求发到 `/v1/images/generations`（或 `/v1/images/edits`），
走插件的 `fetch`，签名方式与 chat 一样。

⚠ **但它同时也会出现在模型列表里。** `pluginCatalog` 不按 `DrawsID` 过滤 —— 所以用户
可能在 chat 里选中一个只会画图的模型，然后收到 400。要不要列，是个取舍：
- 列 → 多了「用它画图」的能力，代价是 chat 列表里多一条选不得的条目
- 不列 → 干净，但放弃一个 magpie 已经支持的能力

⚠ 这条**不在二进制契约里**（是 Go 实现 + `docs/subsystems/provider-plugins.md`），
所以 `extract-contract.py` 抓不到。判据来自源码：`internal/catalog/catalog.go` 的
`DrawsID` / `ImagesAPI`，`internal/gateway/draw.go` 的 `Drawers`，
`internal/provider/plugins.go` 的 `PluginOpenAICompatible`。

---

## 十二、magpie 已经做好的事（插件不用重做）

| 能力 | magpie 的实现 |
|---|---|
| 签到调度 | 北京时间每账号每天一次 + 失败重试 |
| 签到记账 | `plugin-checkin.json` |
| 签到 UI | 「今日已签到 +100 · 连续 21 天」 |
| 额度趋势 | `credits-daily.json` |
| token 续期 | `refreshLead` + 串行化 + 合并保存 |
| 登录作用域 | `inScope(provider, key, ...)` |
| 代理 | `via.run(proxy, ...)`，登录和请求都走 |
| SDK 请求头 | `sdkHeaders(npm, key)` |
| 请求头顺序 | sdkHeaders → loader → gateway → chat.headers |
| 流式转发 | 分帧 + 背压 + base64 |
| 登录态标记 | `X-Magpie-Sign-In` 解析 |
| 多账号分配 | `signInKey` → `provider` 或 `provider#xxxxxx` |
| prompts 流程 | 顺序提问 + when/condition/validate |
| 故障转移 | 限流/5xx 自动换账号或模型 |
| 自动更新 | `@magpie-community/*` 启动后和每小时 |
| 市场发现 | GitHub topic `magpie-plugin`（registry.json 是上游推荐位，提 PR 不必费心）|

**插件只写六个钩子，其余全交给 magpie。**

---

## 十三、写插件前的检查清单

1. `~/.config/magpie/` 下有没有相关状态文件（`plugin-checkin.json` 等）
2. `magpie plugin list` 有没有同类 provider
3. magpie 界面「观测 → 用量」有没有现成展示
4. `magpie-community/plugins` 的 README 表格（25 个插件）
5. 提取二进制里的契约源码（`extract-contract.py`）

**只有确认 magpie 没有、社区也没有，才值得自己写。**

---

## 十四、部署（tgz 的坑）

⚠ **`magpie plugin add xxx.tgz` 有 bug** —— 它把 tgz 当 JS 文件 `import()`，
报 `exports no OpenCode plugin function`。

**正确步骤**：

```bash
# 1. 解压
DST=~/.config/magpie/plugins/node_modules/<包名>
mkdir -p "$DST"
tar -xzf <包名>.tgz -C "$DST" --strip-components=1

# 2. plugins.json 的 plugins 数组加
{"spec": "<包名>"}

# 3. plugins/package.json 的 dependencies 加
"<包名>": "file:./node_modules/<包名>"

# 4. 安装
magpie-bun install
```

**删除时四处都要清**：
1. `plugins.json`
2. `plugins/package.json`
3. `plugins/node_modules/<包名>/`
4. `plugin-auth.json`（账号）
5. `plugin-providers.json`（缓存）
