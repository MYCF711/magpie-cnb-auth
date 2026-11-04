# 内部实现与证据

> README 讲「拿到什么」，这份讲「为什么这么写」。每条结论都尽量给出可复现的判据。
>
> 协议事实的原始出处是 [`411304344/opencode-cnb-account`](https://github.com/411304344/opencode-cnb-account)
> （MIT）—— 它的作者做过真机验证。本仓库重写了实现（按 `magpie-plugin-scaffold` 的结构），
> 并在几处刻意偏离，理由都写在下面。

---

## 1. 数据通道：CNB 有两个站，两套鉴权，不能混

| 站 | 鉴权 | 能干什么 |
|---|---|---|
| `api.cnb.cool` | `Authorization: Bearer <访问令牌>` | `/user`、`/user/groups`、`/{org}/-/repos`、`/{org}/-/charge/*` |
| `cnb.cool` | `Cookie: CNBSESSION[; csrfkey]` + `Csrftoken` 头 | AI 对话、网页侧动作 |

**混用会立刻失败，而且是两种完全不同的失败**：

- 拿 CNBSESSION 打 `api.cnb.cool` → `401`（它不吃 cookie）
- 拿 PAT 打网页 AI 端点 → `403 {"errcode":403,"errmsg":"[NO_RIGHT]OpenAPI only allowed in pipeline"}`

所以「这个账号现在能干什么」由**凭据种类**决定，不由配置决定。判定在
[`src/credential.mjs`](../src/credential.mjs) 里做一次，按凭据本身缓存。

**所有请求都必须带 `User-Agent`。** 缺了会被 Cloudflare 判 bot，回
`403 Error 1010 browser_signature_banned` —— 而且响应体是 HTML，看起来像「路径写错了」。
[`src/http.mjs`](../src/http.mjs) 的 `baseHeaders()` 是唯一的注入点。

**值用「官方客户端」UA，绝不许是 `<产品名>/<版本号>`。** 上游网关按 `<product>/<version>`
形态认「第三方客户端」，命中即回 `403 {"error_code":"TM.00000001","error_msg":"网络繁忙，请稍后重试"}`；
而不显式设 UA 时宿主会把 `magpie/<version>` 原样透传，同样命中。CNB 的官方客户端就是官方网页，
所以 [`src/context.mjs`](../src/context.mjs) 的 `USER_AGENT` 是一条完整合法的 Chrome UA；
`x-cnb-client` 这类自用头用 `CLIENT_TAG`，**不要**把 `USER_AGENT` 塞进自定义头。

---

## 2. 登录：四条路，各自解决不同问题

### 2.1 浏览器设备码（默认那条；也能反复加账号）

RFC 8628，参数与 `cnb-cli` 的 `cnb login` 完全一致：

```
POST https://cnb.cool/oauth2/device/auth    client_id=cnb_cli
  → { device_code, user_code, verification_uri, verification_uri_complete,
      expires_in: 600, interval: 5 }
POST https://cnb.cool/oauth2/token
  grant_type=urn:ietf:params:oauth:grant-type:device_code & device_code & client_id
  → 200 { access_token, refresh_token, expires_in: 28800, token_type: "bearer" }
  → 400 { error: authorization_pending | slow_down | access_denied | expired_token }
```

判据（2026-11-02 实测，申请设备码一步可复现）：

```bash
curl -s -X POST https://cnb.cool/oauth2/device/auth \
  -H "Content-Type: application/x-www-form-urlencoded" -d "client_id=cnb_cli"
```

三个容易被写错的点：

1. **`authorize()` 必须立刻返回** —— 只有 `callback()` 里才轮询。把轮询放进 `authorize`
   会和 magpie 双向死锁（脚手架铁律 2）。
2. **`slow_down` 要加大间隔，不是立刻重试** —— 否则会被当成刷接口。
   这条路的默认总预算取 `min(180s, expires_in)`，与 `cnb-cli` 一致。
   （第 2.4 节那条「浏览器网页登录」会显式把预算改成 `expires_in` 本身 —— 它开着窗口等用户，
   预算比窗口短就会出现「窗口还开着、轮询已经放弃」，用户白点一次却没有额度。）
3. **它不碰 `~/.cnb/token`** —— 这正是「能加多个账号」的原因。

### 2.2 本机 `cnb-cli` 的登录态

文件结构（`~/.cnb/token`，JSON，不是裸串）：

```json
{ "auths": { "cnb.cool": {
    "access_token": "…", "refresh_token": "…", "expires_at": 1792419526,
    "client_id": "cnb_cli", "login_host": "https://api.cnb.cool",
    "platform_url": "https://cnb.cool", "scope": "…" } } }
```

只读、不写。过期就地续期一次（续期结果只留在 magpie 的账号里，**不回写用户文件** ——
回写要过五道同源校验，写错就是「加了新账号却登录成旧账号」，不值得为省一次登录冒险）。

⚠ 这条路**只能读到那一个账号**：`~/.cnb/token` 只由终端的 `cnb login` 写，
在浏览器里换账号不会更新它。

### 2.3 粘贴凭证（PAT 或 CNBSESSION）

magpie 的 `api` 登录方式有一个硬约束：**插件在 `authorize` 里拿不到用户在输入框里填的值**
（宿主只把 `prompts` 的答案作为 `inputs` 传进来）。所以：

- 这个 method **不写 `authorize`、不写 `prompts`**，magpie 直接把输入框的值存成 `{ type: "api", key }`；
- 「这是 PAT 还是 CNBSESSION」在运行时识别一次，**按凭据本身缓存**（用 provider id 当键会让多账号串味）。

形态判据（唯一硬判据，[`src/credential.mjs`](../src/credential.mjs)）：

| | 判据 | 长度 |
|---|---|---|
| 访问令牌 | `/^cnb_(at\|rt)_/` | 90 多字符 |
| CNBSESSION | 三段 `数字.数字.<hex≥16>` | — |

顺序是**按形状先走**，不先试错：拿 CNBSESSION 去打 `api.cnb.cool` 必然 401，
白跑一次还多一条超时风险。只有「两种都不像」时才按「先当令牌试一次」处理，
失败后给出可照做的指引（含生成地址），而不是只说「无效」。

### 2.4 浏览器网页登录（第 4 条路：一次拿额度 + 通道）

前面三条路拿到的都是访问令牌，而 AI 端点只吃 `CNBSESSION`。所以要「一个账号既有额度、
又能跑模型」，必须在**一次登录**里同时拿到两样凭据。做法是把两件事塞进同一个窗口并行跑：

```
POST /oauth2/device/auth             → device_code + verification_uri_complete（带 user_code）
开一个受控 Chromium（一次性 profile） → 直接打开 verification_uri_complete
   用户在窗口里登录 cnb.cool          → CNBSESSION 落进这个临时 profile
   用户点页面上的「确认授权」          → 设备码轮询拿到 access_token
CDP Network.getAllCookies            → 收下 CNBSESSION
```

两个条件**都满足**才收工。[`chromiumLogin({ waitFor })`](../src/browser-login.mjs) 就是那个
「cookie 齐了，还要等另一件事完成」的钩子：只等 cookie 的话，用户还没点「确认授权」窗口就被
关掉、PAT 永远拿不到；反过来只等 token 的话，cookie 可能还没落盘。判定抽成了纯函数
`readyToFinish()` —— 它最容易写成 `||`（等于没等），而真的关窗验一遍要 GUI，跑不进单测。

分账规则只有一种正确写法：

| 凭据 | 放哪 | 谁要用它 |
|---|---|---|
| 访问令牌（PAT） | `auth.access` | 额度 / 组织 / 仓库（`api.cnb.cool`） |
| CNBSESSION | `metadata.session` | AI 通道（`cnb.cool`） |
| csrfkey | `metadata.csrfkey` | 网页侧请求头 `Csrftoken` |

反过来放不只是「顺序问题」：`resolveAccount()` 会拿 session 当 PAT 去查额度（必然 401），
而 `session` 空着 → 模型通道是空的。两种都只坏一半，是最难查的那类错。所以 `kind` 的判定
改成**只看三处**：运行时识别过的缓存 → `metadata.kind` → 凭据形状（`shapeKind()`），
不再按 `auth.type === "oauth"` 猜 —— 浏览器登录也是 oauth 类型，猜必错。

**为什么不能直接读用户自己浏览器的 Cookie 库**：浏览器在跑的时候库文件被独占锁定，
`cp` 与 `node:sqlite` 都打不开（2026-11-02 实测，Edge 正在运行）。只剩「开一个自己的窗口」。

**没组织就顺手建一个。** CNB 的 AI Credit 按组织发放、AI 端点也挂在 `/{org}/{repo}` 下，
而全新账号的 `/user/groups` 是空的（实测 2026-11-02）。设备码拿到的 PAT 建不了组织
（`cnb_cli` 申请不到 `group-manage:rw`，实测 `invalid_scope`），网页登录态可能可以：
`POST https://api.cnb.cool/groups`（`{ path, description }`，需要 `group-manage:rw`）。
slug 由 [`suggestGroupPath()`](../src/org.mjs) 从昵称生成（`Tlaloc` → `tlaloc`、
`cnb.dI2DzHg0QHA` → `di2dzhg0qha`、纯中文昵称兜底 `cnb-user`），撞名加 `-code`。

⚠ **这一段没有真机证据。** 请求形状按 `https://api.cnb.cool/swagger.json` 的 `POST /groups`
写（`{ path, description }`，需要 `group-manage:rw`），但**这个端点认不认 Cookie 未知**。
实现上因此有三条约束：

1. [`createGroupWithSession()`](../src/org.mjs) 返回 `{ ok, status, body }`，**绝不抛**；
2. 只在用户**亲手点**的那条登录路里试**一次**，失败不重试、也不把登录判失败 ——
   `metadata.orgAttempt` 记下 status，卡片按它说话（`orgHint()`）；
3. `usage()` 这类**读钩子绝不建组织**：它只把「点『浏览器网页登录』可以顺带建组织」写进提示。
   读钩子有副作用，是比「功能没做」更贵的错。

---

## 3. 模型目录：CNB 没有 `/models`

它没有公开的模型列表端点，可选的就是固定的 8 个。所以
[`provider.models`](../src/models.mjs) 不做「拉目录」，只做**按通道把能力标对**：

| 通道 | `capabilities.toolcall` | 理由 |
|---|---|---|
| `relay` | `true` | 中继自己是 OpenAI 兼容网关，工具原生 |
| `cookie` | **`false`** | 上游结构性拒绝 tools，标 `true` 就是假声明 |
| 未登录 | `true`（config 里的乐观值） | 登录后由 `provider.models` 纠正 |

**三态降级在这里不适用**：没有「接口失败」这一态，因为没有接口。为了凑形态去编一个
`fetch`，会让「拉取失败退回快照」的语义变成假的。

关于「谁是主模型」：参考实现的源码注释里有一句「CNB 实际只有 `deepseek-v4.1-flash` 在真干活，
其余是静默 fallback 别名」。那是**作者注释，没有附实测记录**，README 里也没有这句。
所以本插件**不做别名重写** —— 如果上游真在静默回退，那是服务端行为，客户端改不了。

---

## 4. 额度：三个接口拼一张卡片

| 接口 | 给什么 |
|---|---|
| `GET /{org}/-/charge/quota` | 当月额度 `credit_in_milli.{total,free}` |
| `GET /{org}/-/charge/volume` | 当月用量 `credit_in_milli`（已用）、`freeze_credit_in_milli`（预扣） |
| `GET /{org}/-/charge/special-amount` | 特权额度 `credit` / `credit_desc` / `credit_expire`（需根组织权限，普通组织 403 属正常） |

- 单位是**毫 Credit**：`1000 milli = 1 Credit`。`privilege = total - free`。
- 重置时间：**下月 1 日 0 点 UTC**，转成 ISO 字符串。
  塞厂商原样格式（`"2026-11-01 00:00:00"`）会让整条窗口被 magpie 丢掉（脚手架坑 22）。
- 窗口一律过 [`src/quota.mjs`](../src/quota.mjs) 的构造器：写法错**当场抛**，
  而不是变成「GUI 显示不对但日志里什么都没有」。

**为什么不伪造 0%**：没有 `used` 的窗口不参与智能路由，一个号所有窗口都不参与，
它在路由页就等于不存在（脚手架坑 24）。反过来，伪造 `used: 0` 会让余额未知的号
排到**队首**。所以读数拿不到时返回 `error` + 空窗口，把原因写在卡片上。

---

## 5. AI 通道：两条，规则不一样

### 5.1 Cookie 直连

```
POST https://cnb.cool/{org}/{repo}/-/ai/chat/completions
  Content-Type: application/json
  Accept: text/event-stream | application/json
  Cookie: CNBSESSION=…[; csrfkey=…]
  Origin: https://cnb.cool
  Referer: https://cnb.cool/{org}/{repo}
  Csrftoken: <csrfkey>            （抓不到就不带）
  User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36
```

四条硬规则：

1. **恒以 `stream:true` 发上游** —— 上游对非流式直接回业务码 `11101`。
   客户端要非流式时，由 [`src/chat.mjs`](../src/chat.mjs) 把 SSE 折叠成一次性 `chat.completion`。
2. **剥掉 `tools` / `tool_choice` / `response_format` / `stream_options`** —— 上游不接受，
   而且报错不提是这个字段的锅。`stream_options` 尤其反直觉：「顺手要个 usage」会把整条请求弄挂。
3. **带 tools 的请求提前返回 501**，不做静默降级。上游拒绝 tools 的文案是
   `403 Agent calls are not allowed` —— 那是个 403，长得像登录问题，
   直接透传会让 magpie 把整个账号标成登录失效。
4. **不要把流读掉** —— 流式请求的 `response.body` 原样交回去，读了客户端只能看到第一段。

`csrfkey` 缺失时会抓一次首页补上；抓不到就不带，多数请求也能过。

> **首页长度不能用来判断「登录了没有」**（2026-11-02 实测证伪：未登录的 `/` 是
> 145,452 字符，而公开仓库页 `/cnb/docs/` 是 227,535 字符 —— 同一个「> 200KB」阈值
> 会把匿名访问判成已登录）。这个启发式已经从 `src/api.mjs` 里删掉；登录有效性只由
> 「拿这条 CNBSESSION 真打一次 AI 端点」决定。

**路径写错时上游回的是什么？**（实测 2026-11-02，和直觉不一样）

| 你发的请求 | 上游回 | 插件映射 |
|---|---|---|
| 带（或缓存了）`csrfkey`，但 CNBSESSION 无效 | `401 {"errcode":16,"errmsg":"Blocked by CSRF."}`（JSON，**不是 HTML**） | 401 · `session_expired` |
| 不带 `csrfkey`，才轮到仓库鉴权 | `403 {"errcode":7,"errmsg":"User has no permission."}` | 502 · `upstream_error`（不标账号） |

也就是说：**CSRF 闸在仓库鉴权之前**，假会话根本走不到「路径写错」那一支；
`text/html` 只在 Cloudflare / 网关拦下来时才出现。所以「仓库路径不对 → 上游回 HTML」
这句旧结论是错的，已经改掉。

### 5.1.1 两个 csrf 值是**两个不同的东西**（真机实测，2026-11-03）

| 值 | 从哪来 | 长度（实测） | 放哪 |
|---|---|---|---|
| `csrfkey` | Cookie `csrfkey` | 10 | **Cookie** |
| `csrftoken` | 页面 HTML 里的 `window.csrftoken` | 40 | **`csrftoken` 请求头** |

把 `csrfkey` 塞进请求头（或把 `csrftoken` 塞进 Cookie）都会被上游回
`401 Blocked by CSRF.` —— 而那句文案看起来像「登录失效」，会把人带到完全错误的方向。
头名就是 `csrftoken`；`X-CSRF-Token` 实测无效（同样是 401）。

---

### 5.2 自建 relay

指向一个 OpenAI 兼容中继。插件把请求头重构一遍再发，不是「只换 Authorization」：

- **换掉**：`Authorization`（填 `relay.key`）、`User-Agent`（打 CNB 时必需的那一个，缺了会被 Cloudflare 拦）
- **丢掉**：`host` / `content-length` / `cookie`（这几个必须由运行时重新算）
- **其余原样透传**：自定义头、`content-type`、工具定义

**这条通道支持工具调用** —— 因为上游是用户自己的网关，不经过 CNB 的 AI 端点。

`auto` 的顺序是 **relay → cookie**：配了 relay 就用 relay。

---

## 6. 错误语义：这一层写错，整批账号都会被停

词表在 [`ERROR-CODES.md`](../ERROR-CODES.md)，实现只在 [`src/http.mjs`](../src/http.mjs) 的
`errorResponse()` 一处。本插件的映射：

| 场景 | status | code | 为什么 |
|---|---|---|---|
| 没有凭据 / 只有 PAT 却要 CNBSESSION | 401 | `sign_in_required` | 确实要人补登录 |
| 登录态被判失效（401，或 403 且明说 login/session/csrf） | 401 | `session_expired` | 带 `X-Magpie-Sign-In: expired` |
| 缺仓库路径 / 请求体坏了 | 400 | `invalid_request` | 用户能自己改 |
| 上游明确说模型不可用 | 404 | `model_not_found` | 只搁置这个模型 |
| 上游 429 | 429 | `rate_limited` | 退避 |
| 上游 5xx | 503 | `upstream_unavailable` | 换号/换模型 |
| 等待超时 / 流被截断 | 504 | `upstream_timeout` | **不许落 502**（不可重试） |
| 带 tools 打 Cookie 通道 | 501 | `not_implemented` | 结构性不支持，换通道才有救 |
| 上游给了明确错误体但归不进上面 | 502 | `upstream_error` | 默认桶 |
| 上游回 HTML | 502 | `upstream_error` | 那是 Cloudflare / 网关页，**不是**模型坏了 |
| 非登录问题的上游 401 / 403 | 502 | `upstream_error` | 落 401 会让宿主把整个账号摘掉，落 404 会搁置模型 —— 两者都错 |

`isLoginBroken()` 是这里最贵的一个判断：判成「失效」会停账号并 failover 到每一个账号；
判成「不是」用户就拿着一个看不懂的 403 干瞪眼。判据来自实测：

- `401` —— 只要不是**在说模型问题**，就是登录问题
- `403` —— 只有明说 `not_logged_in` / `login` / `session` / `csrf` / `登录` 才算

判成「登录失效」之后还要选对**状态码**：只有 `isLoginBroken()` 为真才落 `401`；
其余 401 / 403 一律落 `502 upstream_error`（实现是 `src/chat.mjs` 的 `statusForCookie()`）。

---

## 7. 与参考实现的三处刻意偏离

| 项 | 参考实现 | 本插件 | 理由 |
|---|---|---|---|
| tools 被拒 | 403 `model_not_supported` | **501 `not_implemented`** | 403 在 magpie 的语义里通向「登录失效」，会连累整个账号；这是「能力不支持」，不是「你没登录」 |
| 页面 / 面板 / 快照 | 带 `page/` 与 `page/panel.html`（沙箱内不能联网，靠宿主写快照） | **不做页面** | 脚手架没有页面形态；信息全走 `usage()` 的窗口，卡片上直接能看到，不需要两套渲染 |
| 仓库名 | 登录时探测后写进 metadata，续期时复用 | **每次重算**（选项 > 登录快照 > 可见仓库第一个） | 烘进按凭据缓存的档案里会「改了选项不生效」；这条是被测试逼出来的 |

另外两处与脚手架的差异：

- `tests/mount.test.mjs` / `tests/semantics.test.mjs` 按本插件重写：锁的是设备码轮询的状态机、
  禁字段剥离、tools 的 501、额度窗口的路由可见性、徽章合并规则 —— 模板那套（free 三分支 /
  计费接口降级）在 CNB 上不适用。
- `src/context.mjs` 的 `MODEL_SPECS` 是**唯一**的模型真源，`config` 与 `provider.models`
  两条路径都由 `modelEntry()` 生成，避免「两个钩子各写一份、改一处漏一处」。

---

## 8. 已知限制与未验证项

1. **Cookie 通道不支持工具调用。** 这是 CNB 上游的结构性限制，不是插件能绕的。
2. **额度必须用访问令牌查。** 只有 CNBSESSION 的账号，卡片上会明说补一个 PAT。
3. **`/user/identity`、`/user/ext_identity`、`/user/charge/ext_identity/privilege`
   是控制台页面，不是 API。** 本插件从不请求它们 —— 任何关于其响应体的说法都是臆测。
   徽章只从 `GET /user` 的 `identity_providers` 与特权额度说明里推。
4. **上下文窗口取自参考实现的实测表**，本仓库没有重新做长上下文压测。
   如果你发现某个模型实际窗口不同，改 `src/context.mjs` 的 `MODEL_SPECS` 即可（测试会跟着走）。
5. **真实链路验证做到哪一步**（详见 [`live-verification.md`](./live-verification.md)）：
   本机 magpie 用隔离的配置目录（`HOME` 覆盖，不碰你自己的 `~/.config/magpie`）装载过本插件，
   `magpie plugin add <本仓库路径>` → `cnb (云原生构建 CNB, 8 models)`；设备码登录**真的走完了**
   （`magpie plugin login cnb` 领到 `user_code`，授权确认后 `signed in as Tlaloc`），
   `magpie quota` / `magpie provider test cnb` 都按插件的预期回答。
   **没做到的**：这条账号没有组织，所以额度三接口的成功读数、Cookie 通道发真实消息这两段
   只有离线测试与错误映射实测，没有真读数 —— 等你有组织后跑一次 `magpie quota` 就能补上。
6. **全新账号可能一个组织都没有。** 实测（2026-11-02，当天注册的账号）：`GET /user/groups`
   返回 `[]`。CNB 的 AI Credit 按组织发放、AI 端点也挂在 `/{org}/{repo}/-/ai/...` 下，
   所以这种账号既没有额度可读、也没有通道可用 —— 卡片会直接给出 `cnb.cool/new/groups` 的入口，
   而不是让你反复「重新登录」。
7. **只拿到「免费额度」而拿不到「总量」时，窗口是钱包型（只有 `balance`、没有 `used`）。**
   这种窗口 magpie 的卡片会照常显示，但**智能路由不计入它**（AGENTS 坑 24：路由只看 `used`）。
   没有总量就没有分母，硬编一个占比是假数据 —— 所以这里选择「显示余额、不参与排序」。
   正常账号三个接口都会返回 `total`，走不到这条。
8. **包里带着脚手架的通用模块**（`oauth-pkce` / `browser-login` / `desktop-import` /
   `invite` / `rotation-captcha` / `tool-schema` / `request-rewrite` / `vision-clock` /
   `tempmail-client` / `store` / `model-context` / `local-browser`）。CNB 这个供应商用不到它们，
   但它们是脚手架的一致契约、并有各自的测试。**将来接别的站点时按需用，别以为删除是「清理」。**
   （`browser-login` 现在有调用方了：`src/web-login.mjs` 的第 4 条登录路。）
9. **「浏览器网页登录」没有真机证据 —— 只有离线测试。** 本机 Edge 正在运行、Cookie 库被独占
   锁定，也就没有可用的 CNBSESSION 来跑一遍完整流程（见第 2.4 节）。**验证过的**：
   `waitFor` 的判定语义（`readyToFinish()` / `pollCookies()` 的离线测试）、四种结局的分账
   （注入假实现跑通，见 `tests/web-login.test.mjs`）、`POST /groups` 的请求形状
   （见 `tests/org.test.mjs`）。**没验证的**：① 受控窗口里 cnb.cool 的登录页会不会被风控拦；
   ② 登录完成后页面是否会自动回到带 `user_code` 的确认页（不回的话用户只拿到 session 那一半）；
   ③ cookie 鉴权能不能过 `POST /groups`；④ 建出来的组织能不能立刻查到额度和仓库。
   这四件事等有 CNBSESSION 的账号跑一次 `magpie plugin login cnb`（选第 3 条）就能补上。
