# 真实链路验证（2026-11-02）

> 结论先说：`node scripts/live-verify.mjs` 真打上游，**通过 5 · 失败 0**，
> `node scripts/privacy-scan.mjs` 退出 0。同时留下 **5 条需要 Lead 处置的问题**，
> 以及一节「这份验证不能证明什么」——后者和前者一样重要。

---

## 1. 为什么做这次验证

`tests/` 里那 16 个测试文件全部是**离线**的：`fetch` 是伪造的，锁的是形状（字段齐不齐、
状态码映射对不对），锁不住「上游到底怎么回」。这一点插件作者自己也写下来了 ——
[`docs/internals.md`](./internals.md) §8.5：

> 5. **没有真实的 CNB 账号做端到端验证**：结构、协议形状、错误映射、额度窗口都覆盖了离线测试；
>    真机登录需要你点一次浏览器授权。

于是 [`docs/internals.md`](./internals.md) 里的若干协议事实是从参考实现的**注释**里搬来的，
没有本仓库自己的实测记录；而其中几条一旦不成立，后果不是报错，而是**静默错**：

| 假设 | 不成立时的表现 |
|---|---|
| `POST /oauth2/device/auth` 的参数与返回字段名 | 点登录后「授权失败」，但看不出是哪个字段 |
| 假令牌 → `401` | 若上游改回 `403`，`isLoginBroken()` 会判成「不是登录问题」，用户拿到一个读不懂的 403 |
| 坏 CNBSESSION → `401` 且能被 CSRF 重发救回 | 若重发没有上限，一次抖动会把上游刷成限流 |
| relay 通道原样转发 `tools` | 工具调用被悄悄降级，agent 表现成「不会用工具」 |
| `authorize()` 立刻返回 | 与宿主双向死锁，界面一直转圈 |

这次验证的目标只有一个：**把「协议假设」换成「有状态码、有字段、有耗时、能一条命令复跑」的证据。**
判据写死在脚本里，宁可红，也不要假绿。

---

## 2. 怎么跑

```bash
node scripts/live-verify.mjs       # 五项全打一遍：实测约 9 秒（全文计时 8688ms）
node scripts/privacy-scan.mjs      # 0 = 干净（脚本与本文都在扫描范围内）
```

- **依赖**：Node ≥ 22（用到了 `AbortSignal.timeout` / `Response.prototype.bodyUsed` / `headers.getSetCookie`）、
  能直连 `cnb.cool` 与 `api.cnb.cool`。
- **幂等**：不写任何文件、不碰 `~/.config/magpie`、不装插件、不重启任何进程、
  **不完成任何 OAuth 授权**（设备码申请完就让它自然过期）。
- **超时与重试**：每个真实请求 ≤ 20s。**网络级抖动**（`ECONNRESET` / `fetch failed` / 连接超时）
  会让**整项检查**重跑一次，且重跑前清空计数 —— 所以日志里的「上游 POST 2 次」不会被重试放大成 4 次。
  4xx/5xx 是上游的真实回答，不重试：重试会把「上游调用次数」这类计数证据弄脏。
- **脱敏**：凭据一律是明显的假值（`fake-pat-for-live-probe` / 32 个 `f` 拼出的三段 CNBSESSION），
  日志里显示为 `<FAKE>`；真实 `csrfkey` / `csrftoken` **只打印长度，不打印值**。
- **退出码**：`0` = 五项全过；`1` = 有失败（逐条打印真实错误，不吞）。
- **relay**：脚本在 `127.0.0.1` 的**随机端口**起一个假 OpenAI 兼容中继，跑完立即 `close`。
  所以每次输出里的端口都不一样，这是正常的。

一次真实输出（端口、时延、`htmlLength` 每次略有不同，其余逐字来自 2026-11-02 的一次运行）：

```text
live-verify —— 真打上游的验证（不是单测）
日期 2026-11-02 · node v24.20.0 · 上游 https://cnb.cool / https://api.cnb.cool · 仓库页 cnb/docs
凭据一律用假值（日志里显示为 <FAKE>），不完成任何授权，不写任何文件。

✓ 1 设备码 OAuth — 原样 POST https://cnb.cool/oauth2/device/auth（client_id=cnb_cli）→ HTTP 200 · application/json;charset=UTF-8
    · 响应字段：Header, device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval
    · 代码不读的字段：Header=null
    · requestDeviceCode() → platform=https://cnb.cool · clientId=cnb_cli · userCode=<user_code 8 位> · deviceCode=cnb_dc_…(len 94) · expiresIn=599 · interval=5
    · POST https://cnb.cool/oauth2/token（轮询一次）→ HTTP 400 · error=authorization_pending
    · pollDeviceToken(maxWaitMs=6000) → 2 次轮询 · 6064ms 后退出：等待授权超时，重新点一次登录即可

✓ 2 PAT 通道 — GET https://api.cnb.cool/user（Bearer <FAKE>）→ HTTP 401 · application/json; charset=utf-8
    · 响应体形状：{ errcode:number, errmsg:string } · 原文：{"errcode":16,"errmsg":"The task will not run because the user is not logged in."}
    · fetchUser() 抛出 → status=401 · signIn=expired
    · identifyCredential() 抛出 → status=401 · signIn=expired

✓ 3 Cookie 通道 — GET https://cnb.cool/cnb/docs/ → HTTP 200 · text/html; charset=utf-8 · 228103 字节 / 227535 字符
    · Set-Cookie 里的 csrfkey：有（长度 9，值不打印）
    · HTML 里 window.csrftoken：有
    · fetchCsrf()（打 "/"）→ csrfkey 有(长度 9) · csrfToken 有 · htmlLength=145454 · looksLoggedIn=false
    · case a（无缓存 csrfkey）→ HTTP 401 · application/json; charset=utf-8 · 是 HTML=false · x-magpie-sign-in=expired · code=session_expired · 上游 POST 1 次 / 抓 csrf 2 次
    · case b（陈旧 csrfkey=stale-csrf-for-live-probe）→ HTTP 401 · x-magpie-sign-in=expired · code=session_expired · 上游 POST 2 次（首次 + 重发）
    · case c（仓库路径 cnb/no-such-repo-live-probe）→ HTTP 401 · code=session_expired · x-magpie-sign-in=expired · 上游 POST 1 次 · 是 HTML=false
    ·     ↑ 假 CNBSESSION 下 CSRF 闸先回答，路径写错的分支不可达；路径那条见 case e
    · case d（带 tools）→ HTTP 501 · code=not_implemented · 上游调用 0 次
    · case e（不带 csrfkey，才走到仓库鉴权）→ 上游 HTTP 403 · application/json; charset=utf-8 · 体 {"errcode":7,"errmsg":"User has no permission."}
    · case e 映射 → isLoginBroken=false · statusForUpstream(403)=502 · codeForStatus=upstream_error

✓ 4 relay 通道 — buildLoaderResult() → baseURL=http://127.0.0.1:57178 · apiKey="" · fetch=function
    · ① tools → relay 收到 HTTP POST /chat/completions · tools=1 条 · 回包 finish_reason=tool_calls · tool_calls[0]=get_weather
    · ② 非流式 → HTTP 200 · application/json; charset=utf-8 · object=chat.completion · content=relay-non-stream-ok
    · ②b foldSse → object=chat.completion · choices=1 · content=中继分段内容 · finish=stop · usage.total_tokens=26
    · ③ 流式 → HTTP 200 · text/event-stream; charset=utf-8 · 交回时 bodyUsed=false（流还没被读过，透传正确） · 读到 5 个 data 帧（含 [DONE]）· 末帧=data: [DONE]

✓ 5 九钩子装配 — config({}) → provider.cnb · npm=@ai-sdk/openai-compatible · models=8 条（deepseek-v4.1-flash, deepseek-v4-flash, glm-5.3…）
    · auth.methods → [oauth:浏览器授权登录（可加多个账号） | oauth:用本机 cnb-cli 的凭证（跳过浏览器） | api:粘贴访问令牌（PAT 或浏览器 CNBSESSION 都行）]
    · 第 1 条 authorize() → 46ms · 出网 1 次（POST /oauth2/device/auth）· 轮询 0 次
    · 第 2 条 authorize() → 0ms · 出网 0 次

通过 5 · 失败 0
```

> `userCode` 在日志里只给长度：它虽然是一次性的、10 分钟内作废，但仍然是真实凭据的一部分。
> 真实的 `csrfkey` / `csrftoken` / `device_code` 同样只打印长度或前缀。

---

## 3. 五项各自的做法与判据

### 3.1 设备码 OAuth —— 只走前两步，不完成授权

**做法**：先原样复刻 [`src/device.mjs`](../src/device.mjs) 的请求（表单 POST + `baseHeaders()` 的 UA +
`client_id=cnb_cli`，**没有 scope**），记下真实状态码与全部响应字段；再走一遍代码自己的
`requestDeviceCode()` 解析；最后轮询一次 `POST /oauth2/token`，并让 `pollDeviceToken()` 在 6 秒预算内
自然耗尽 —— 全程**没有任何人点「确认授权」**，设备码会自己过期。

**判据**：

1. `POST /oauth2/device/auth` 返回 `200`；
2. `device_code` / `user_code` / `verification_uri` / `verification_uri_complete` / `expires_in` / `interval` 六个字段都在，
   **且字段名与代码读的一致**（代码读不到的字段要点名）；
3. `requestDeviceCode()` 归一化后的对象非空且自洽（`deviceCode` 前缀 `cnb_dc_`、`verification_uri_complete` 里含 `user_code`）；
4. 未授权时的轮询返回 `error` ∈ `authorization_pending` / `slow_down` / `access_denied` / `expired_token`
   （即 `src/device.mjs:86-91` 那张表的键）；
5. `pollDeviceToken()` 遇到 `pending` 会**继续轮**，预算到点抛「等待授权超时」而不是一直挂着。

**实测**：

- `200`，`application/json;charset=UTF-8`；
- 响应字段：`Header`、`device_code`、`user_code`、`verification_uri`、`verification_uri_complete`、`expires_in`、`interval`；
- **代码不读的字段：`Header`（值为 `null`）** —— 是个响应头占位，不影响任何判断；
- `device_code` 94 个字符、前缀 `cnb_dc_`；`expires_in` 实测 **599**（另一次是 600），`interval=5`；
- 轮询一次：`400 {"error":"authorization_pending"}`；
- `pollDeviceToken(maxWaitMs=6000)`：2 次轮询、6056ms 后抛「等待授权超时，重新点一次登录即可」。

> `expires_in` 一次 599 一次 600，[`src/device.mjs`](../src/device.mjs) 有 `|| 600` 兜底，
> 语义不受影响；但 [`docs/internals.md`](./internals.md) §2.1 把它写成固定的 `600`，见第 5 节小事实。

### 3.2 PAT 通道 —— 假令牌打真 OpenAPI，看它被归成哪一类

**做法**：`GET https://api.cnb.cool/user`，`Authorization: Bearer fake-pat-for-live-probe`（故意不带 `cnb_at_` 前缀，
免得分不清上游拒的是「令牌」还是「前缀」）。记真实状态码与响应体形状；再让 `fetchUser()` 与
`identifyCredential()` 各走一遍，看插件把它归到哪一类。

**判据**：

1. 上游 `401` 且 `content-type` 是 JSON；
2. `fetchUser()` 抛出的错误带 `status: 401` + `signIn: "expired"`，并且 **`message` 里保留上游原文**
   （只说「无效」等于什么都没说）；
3. `isLoginBroken(401, 真实响应体) === true`；
4. `identifyCredential()` 抛 `401` / `signIn: expired`，**不能**被误判成 `404`（404 只搁置模型，会把真问题藏起来）。

**实测**：

- `401` `application/json; charset=utf-8`，体形状 `{ errcode: number, errmsg: string }`，
  原文 `{"errcode":16,"errmsg":"The task will not run because the user is not logged in."}`；
- `fetchUser()` → `status=401` / `signIn=expired`，message 含 `401` 与上游 `errmsg`；
- `identifyCredential()` → `401` / `signIn=expired`，message 为「粘贴的凭证无效：…」并说明了凭据长相；
- **没有**被误判成 404 / 模型不可用 / 502。

> **名词对不上**：任务书与 [`AGENTS.md`](../AGENTS.md) 第 192 行把这一层描述成
> `asModelError` / `asSignInExpired`，但真实 [`src/api.mjs`](../src/api.mjs) 里**没有这两个函数**。
> 实际的映射点是 `cnbApi()` 的 [`src/api.mjs:57-62`](../src/api.mjs#L57-L62)（拼错误 + 打 `signIn` 标）
> 与 [`src/http.mjs:132-141`](../src/http.mjs#L132-L141) 的 `isLoginBroken()`。见第 5 节问题 1。

### 3.3 Cookie 通道 —— 假 CNBSESSION，重点数「上游被调了几次」

**做法**：先 `GET https://cnb.cool/cnb/docs/`（一个**真实存在的公开仓库**）拿 `Set-Cookie: csrfkey=…`；
再经 [`buildCookieFetch()`](../src/chat.mjs) 向 `https://cnb.cool/cnb/docs/-/ai/chat/completions` 发请求。
脚本把 `globalThis.fetch` 换成计数代理（`src/` 里全是裸 `fetch(...)`，一换就全数到），
按 host + method + path 分类计数。

五个 case：

| case | 构造 | 想验证什么 |
|---|---|---|
| a | 账号里没有 `csrfkey`（刚粘完 CNBSESSION 的常态） | 插件会自己抓一次 csrf，再发请求；假会话被判成登录失效 |
| b | 账号里带一个**陈旧** `csrfkey`（上次会话留下的） | 401 + `Blocked by CSRF` 之后**只重发一次**，不会无限重试 |
| c | 仓库路径写错 | 记录真实现象（结论：这套假凭据下走不到路径判断） |
| d | 带 `tools` | 在出网**之前**就返回 501，0 次上游调用 |
| e | 不带 csrfkey 直发，才走到仓库鉴权 | 真实 403 响应体 → 插件映射后不能标账号失效 |

**判据**：

1. case a：`401` + `code=session_expired` + `x-magpie-sign-in: expired` + `content-type` 是 JSON（不是 HTML）；
2. case b：上游 POST **恰好 2 次**（首次 + 一次重发）—— 这是「最多重发一次」的直接证据；
3. case d：`501` + `code=not_implemented` + **0 次**上游调用；
4. case e：`403 {"errcode":7,...}` → `isLoginBroken=false`、`statusForUpstream(403)=502`、`code=upstream_error`；
5. 全程没有任何 case 出现第 3 次重发。

**实测**：

- 仓库页 `200`、`text/html`、**228103 字节 / 227535 字符**，`Set-Cookie` 里有 `csrfkey`
  （这次是 9 位数字串，另一轮是 6 位 —— 长度会变，值一律不打印），
  HTML 里有 `window.csrftoken`；
- `fetchCsrf()`（打 `/`）也能解析出 `csrfkey` 与 `csrfToken`，`htmlLength=145452`、`looksLoggedIn=false`；
- case a：`401` / `session_expired` / `expired` / 非 HTML，**上游 POST 1 次、抓 csrf 2 次**；
- case b：`401` / `session_expired` / `expired`，**上游 POST 2 次**；
- case c：`401` / `session_expired`（假凭据下 CSRF 闸先回答）；
- case d：`501` / `not_implemented` / **0 次上游调用**；
- case e：上游 `403` `{"errcode":7,"errmsg":"User has no permission."}` → `502` / `upstream_error` / 不带 `x-magpie-sign-in`。

**这一节最有价值的一条实测**（case a 的「抓 csrf 2 次、POST 1 次」）：
重发条件是 `fresh !== csrf`（[`src/chat.mjs:210`](../src/chat.mjs#L210)），而 `GET https://cnb.cool/`
连抓三次返回的是**同一个** `csrfkey` —— 所以「刚抓过就发」这条路径上，第二次抓取拿到的值等于第一次，
**只会重抓、不会重发**。重发只在「账号里缓存了陈旧 csrfkey」时才发生，而且上限就是 1 次。详见第 5 节问题 4。

### 3.4 relay 通道 —— 本机假中继，端到端三种请求

**做法**：在脚本进程内用 `node:http` 起一个假 OpenAI 兼容中继，监听 `127.0.0.1` 的**随机端口**，
把 `http://127.0.0.1:<port>/v1` 塞进 `normaliseOptions({ relay: { url } })`，再通过
`buildLoaderResult({ getAuth, options })` 拿到 `{ baseURL, apiKey, headers, fetch }`，用它发三种请求。
中继把收到的每个请求（方法/路径/头/体）都记下来，断言针对**它实际收到的内容**。

**判据**：

1. `baseURL` 是 `http://127.0.0.1:<port>`（`/v1` 被 `relayBase()` 剥掉）；没配 `key` 时 `apiKey` 为空串；
2. **带 tools**：中继收到的 `tools` 与发出去的**逐字节一致**，`tool_choice` 也在；客户端带来的
   `authorization` 被剥掉、`user-agent` 被换成插件自己的、自定义头原样透传；中继的 `tool_calls` 回到客户端；
3. **非流式**：拿到一次性 `chat.completion`（`object=chat.completion`、内容对、**响应里没有 `data:` 帧**）；
4. **SSE 折叠**：把中继真回的 SSE 交给 `foldSse()`（cookie 通道用的是同一段代码），
   得到**一条** choice、内容等于所有帧拼接、`usage` 帧（`choices: []`）也被保留；
5. **流式**：`200` + `text/event-stream`，**交回客户端时 `bodyUsed === false`**（流没被读干），
   自己读能读满 5 个 `data:` 帧（3 内容帧 + usage 帧 + `[DONE]`）。

**实测**：

- `baseURL=http://127.0.0.1:53673`、`apiKey=""`、`fetch` 是函数；
- ① 中继收到 `POST /chat/completions`，`tools` 1 条，回包 `finish_reason=tool_calls`、
  `tool_calls[0].function.name=get_weather`；
- ② `200` `application/json`，`object=chat.completion`，`content=relay-non-stream-ok`；
- ②b `foldSse` → `object=chat.completion`、1 条 choice、`content=中继分段内容`、`finish=stop`、`usage.total_tokens=26`；
- ③ `200` `text/event-stream`、`bodyUsed=false`、5 个 `data:` 帧、末帧 `[DONE]`；
- 中继一共收到 4 个请求（tools / 非流式 / 折叠用流式 / 透传用流式）。

> 注意 relay 通道是**直通**：[`src/chat.mjs:264-295`](../src/chat.mjs#L264-L295) 原样返回上游 `Response`，
> 不做折叠。所以「SSE 折叠」这条能力是靠 `foldSse()` 单独验证的 —— 它是 cookie 通道
> （[`src/chat.mjs:249-255`](../src/chat.mjs#L249-L255)）实际调用的同一段代码。

### 3.5 九钩子装配 —— 形状 + `authorize()` 的时延

**做法**：`import` 入口 `index.mjs`，`CnbAuthPlugin({}, {})`，只验形状不验业务；再实测第 1 条
`authorize()` 的**返回时延**与**出网次数**。

**判据**：

1. 返回对象含 `config` 函数、`auth.methods`（**3 条**且各自形状正确）、`auth.refresh`、`auth.loader`、
   `auth.usage`、`auth.checkin`、`provider.models`、`"chat.headers"`；
2. 3 条登录方式：`oauth` + `authorize`；`oauth` + `authorize`；`api` + `placeholder` 且
   **没有 `authorize`、没有 `prompts`**（[`index.mjs:209-221`](../index.mjs#L209-L221) 的注释说明了原因：
   否则用户粘进输入框的值进不来）；
3. `config({})` 之后 `cfg.provider.cnb.models` 非空（铁律 1）；
4. 第 1 条 `authorize()` **< 2000ms**、**不轮询 token**、出网 **≤ 1 次**。

**实测**：

- 八个钩子齐全；`auth.provider=cnb`、`provider.id=cnb`、`npm=@ai-sdk/openai-compatible`；
- `config({})` → 8 条模型（`deepseek-v4.1-flash`、`deepseek-v4-flash`、`glm-5.3` …）；
- 3 条登录方式的 type / label 都对，粘贴那条确实没有 `authorize` / `prompts`、`placeholder` 非空；
- 第 1 条 `authorize()`：**46ms**、出网 **1 次**（`POST /oauth2/device/auth`）、**轮询 0 次**，返回对象带
  `url` / `instructions` / `method: "auto"` / `callback`；
- 第 2 条 `authorize()`（本机 cnb-cli）：**0~1ms**、出网 **0 次**。

> 第 1 条的「出网 1 次」是**实测事实**，与「authorize 不发起网络」的说法不一致 —— 见第 5 节问题 5。
> 这里没有把它写成失败：设备码流程不请求一次 `device/auth` 就拿不到 `user_code`，先显示一个空 URL 再
> 在 callback 里申请，用户看到的是「点开页面、码是空的」。这属判据层面需要 Lead 裁定的分歧，不是缺陷。

---

## 4. 实测结果表

| # | 项 | 命令 | 真实状态码 / 关键字段 | 结论 | 日期 |
|---|---|---|---|---|---|
| 1 | 设备码 OAuth | `node scripts/live-verify.mjs`（第 1 项）<br>`curl -s -X POST https://cnb.cool/oauth2/device/auth -H "Content-Type: application/x-www-form-urlencoded" -H "User-Agent: magpie-cnb-auth/0.1.0" -d "client_id=cnb_cli"` | `200` · 六字段齐全（另有代码不读的 `Header=null`）· `expires_in=599` `interval=5` · 轮询 `400 authorization_pending` · 6s 预算内 2 次轮询后超时退出 | **通过** | 2026-11-02 |
| 2 | PAT 通道 | `node scripts/live-verify.mjs`（第 2 项）<br>`curl -s https://api.cnb.cool/user -H "Authorization: Bearer fake-pat-for-live-probe" -H "User-Agent: magpie-cnb-auth/0.1.0"` | `401` · `{"errcode":16,"errmsg":"The task will not run because the user is not logged in."}` · 插件 → `status=401` `signIn=expired`，未误判成 404/502 | **通过** | 2026-11-02 |
| 3 | Cookie 通道 | `node scripts/live-verify.mjs`（第 3 项）<br>`curl -s https://cnb.cool/cnb/docs/ -H "User-Agent: magpie-cnb-auth/0.1.0"` 取 `Set-Cookie: csrfkey` | 仓库页 `200 text/html` 228103 字节 · AI 端点 `401 {"errcode":16,"errmsg":"Blocked by CSRF."}` · 映射 `401 / session_expired / x-magpie-sign-in: expired` · CSRF **上游 POST 恰好 2 次**（1 次重发）· 带 tools `501 / 0 次出网` · 真实 403 体 → `502 / upstream_error` | **通过** | 2026-11-02 |
| 4 | relay 通道 | `node scripts/live-verify.mjs`（第 4 项，本机假中继 `127.0.0.1:<随机>`） | `tools` 原样到达（1 条，`tool_calls[0]=get_weather`）· 非流式 `200 chat.completion` · `foldSse` → 1 条 choice + `usage.total_tokens=26` · 流式 `200 text/event-stream`、`bodyUsed=false`、5 帧到齐 | **通过** | 2026-11-02 |
| 5 | 九钩子装配 | `node scripts/live-verify.mjs`（第 5 项） | 8 个钩子齐全 · `config({})` → `provider.cnb.models` 8 条 · `auth.methods` 3 条 · 第 1 条 `authorize()` **46ms**、出网 1 次、轮询 0 次 · 第 2 条 ≤1ms、出网 0 次 | **通过** | 2026-11-02 |

汇总：**通过 5 · 失败 0**；`node scripts/live-verify.mjs` 退出码 `0`，`node scripts/privacy-scan.mjs` 退出码 `0`。

---

## 5. 发现的问题

以下五条**都没有改代码**（本次任务的写作范围只有 `scripts/live-verify.mjs` 与本文），交给 Lead 处置。
按「会不会静默出错」排序。

### 问题 1 · `AGENTS.md` 写的 `src/api.mjs` 函数清单与真实文件不符

- **位置**：[`AGENTS.md:192`](../AGENTS.md#L192)
- **写法**：`| src/api.mjs | headersFor / read / get / asModelError / asSignInExpired | …`
- **实际**：`src/api.mjs` 导出的是 `TIMEOUT, cnbApi, cnbWeb, fetchCsrf, fetchQuota, fetchSpecialAmount, fetchTopGroups, fetchUser, fetchVolume, listRepos`
  —— **`headersFor` / `read` / `get` / `asModelError` / `asSignInExpired` 一个都不存在**（这是模板那一版的名字）。
- **复现**：
  ```bash
  node -e 'import("./src/api.mjs").then(m => console.log(Object.keys(m).join(", ")))'
  ```
- **影响**：照文档找落点的人会白找一轮（本次任务的说明里就让我找 `asModelError` / `asSignInExpired`）。
  真实的错误映射在 [`src/api.mjs:57-62`](../src/api.mjs#L57-L62) 与 [`src/http.mjs:132-141`](../src/http.mjs#L132-L141)。
- **建议**：把这一行换成真实导出；或在文档里注明「模板名 → 本仓库实际名」的对照。

### 问题 2 · `looksLoggedIn` 的 200KB 阈值不成立，而且没有任何调用方

- **位置**：[`src/api.mjs:182`](../src/api.mjs#L182)（阈值）、[`src/api.mjs:163-167`](../src/api.mjs#L163-L167)（注释声称的用途）
- **实测**：`GET https://cnb.cool/` 未登录是 **145,452 字符**（判 `false`）；而**公开仓库页**
  `GET https://cnb.cool/cnb/docs/` 是 **227,535 字符** —— 同一套判据会把一个未登录的仓库页判成「已登录」。
- **更关键**：`grep -rn "looksLoggedIn" src index.mjs tests` 只命中定义处；
  [`src/chat.mjs`](../src/chat.mjs) 调用 `fetchCsrf()` 时**只取 `.csrfkey`**。也就是说这个字段是死的。
- **复现**：
  ```bash
  node -e 'import("./src/api.mjs").then(async m => { const r = await m.fetchCsrf({ session: "x" }); console.log(r.htmlLength, r.looksLoggedIn) })'
  grep -rn "looksLoggedIn" src index.mjs tests
  ```
- **影响**：当前无行为影响（没人读它）；但注释把它说成「区分登录过期和路径写错的判据」，
  会诱导后来者用它做判断，而它在仓库页上就是错的。
- **建议**：要么删掉这个字段并改注释，要么把判据换成「`/user` 或某个登录态端点是否 200」。

### 问题 3 · 文档说「仓库路径不对 → 上游回 HTML」，实测不是

- **位置**：[`docs/internals.md:168`](./internals.md#L168)（§5.1 末尾）、
  [`src/chat.mjs:225-226`](../src/chat.mjs#L225-L226)（`htmlInstead` 的提示文案）、
  [`src/chat.mjs:87-90`](../src/chat.mjs#L87-L90)（`htmlInsideFixup`）
- **实测两种真实回答**（都来自 `cnb.cool`，都对同一个不存在的仓库
  `cnb/no-such-repo-live-probe` 发 `POST /-/ai/chat/completions`）：
  - **不带** `csrftoken` / `csrfkey`：`403 {"errcode":7,"errmsg":"User has no permission."}` —— JSON，不是 HTML；
  - **带**任意 `csrfkey`：`401 {"errcode":16,"errmsg":"Blocked by CSRF."}` —— CSRF 闸在仓库鉴权**之前**。
- **复现**：`node scripts/live-verify.mjs` 的 case c / case e（脚本里两段都有注释）。
- **影响**：`htmlInstead → 502` 这条分支在「路径写错」场景下**根本不会被触发**，
  提示文案「通常是仓库路径不对」用户永远看不到；实际看到的是
  「CNB 上游 403：User has no permission.」。分类本身是对的（403 → 502、不停账号），只是文档与文案对不上。
  另外 `docs/internals.md` 说「未登录首页只有几十 KB，这个长度差顺手用来区分」——
  实测未登录首页是 **145KB**，不是「几十 KB」。
- **建议**：改掉这两处措辞，或补一条「路径写错实测是 403 JSON」的实测记录。

### 问题 4 · CSRF 重发在「刚抓过 csrfkey」的路径上不会触发（机制说明，不是缺陷）

- **位置**：[`src/chat.mjs:203-212`](../src/chat.mjs#L203-L212)，关键是 [`src/chat.mjs:210`](../src/chat.mjs#L210) 的 `fresh !== csrf`
- **实测**：`GET https://cnb.cool/` 在**同一个 `CNBSESSION` 值下**连续三次返回**同一个** `csrfkey`
  （是个短数字串，6~9 位，换了会话值/过一段时间就会变）。
  于是「首次抓取 → 立刻发送 → 401 Blocked by CSRF → 再抓一次」这条路径上，`fresh === csrf`，
  **只会重抓、不会重发**（case a：上游 POST 1 次、抓 csrf 2 次）。
  只有账号里预置了一个**陈旧** `csrfkey` 时才会重发，且**恰好一次**（case b：上游 POST 2 次）。
- **复现**：
  ```bash
  node -e 'import("./src/api.mjs").then(async m => { for (let i = 0; i < 3; i++) console.log((await m.fetchCsrf({ session: "x" })).csrfkey.length) })'
  ```
- **影响**：重发上限确认是 1 次，**不会无限重试**（这一点达标）。但「首次抓到的 key 已经失效」这种
  情况救不回来，会直接落 `session_expired`。考虑到该 key 对同一客户端是稳定的，这个取舍可以接受。
- **建议**：只在 [`src/chat.mjs:203-205`](../src/chat.mjs#L203-L205) 的注释里补一句
  「本 key 对同一客户端稳定，因此这条重发主要覆盖『缓存值陈旧』，不覆盖『首抓即失效』」。

### 问题 5 · `authorize()` 实测会出网一次，与「不发起网络」的判据不一致

- **位置**：[`index.mjs:179-182`](../index.mjs#L179-L182) → [`src/device.mjs:165-178`](../src/device.mjs#L165-L178)
  （`loginViaDevice()` 里第 168 行就 `await requestDeviceCode(...)`）
- **实测**：第 1 条 `authorize()` **46ms**、出网 **1 次** `POST /oauth2/device/auth`、轮询 **0 次**。
  第 2 条（本机 cnb-cli）**0~1ms**、出网 **0 次**。
- **复现**：`node scripts/live-verify.mjs` 第 5 项。
- **影响**：**时延**达标（< 2000ms，且没有把轮询放进 authorize）。但与「authorize 不发起网络」
  的字面判据冲突。这属判断题：设备码流程不请求这一步就没有 `user_code` 可展示；
  [`src/device.mjs:156-163`](../src/device.mjs#L156-L163) 的注释也是按「允许一次很短的请求」写的。
- **建议**：交 Lead 裁定 —— 若要严格零出网，就得把 `requestDeviceCode` 挪进 `callback`
  并把 `url` 先返回成裸 `verification_uri`（代价：码显示不出来）。**不建议在没有宿主实测之前改。**

### 小事实（不影响结论，但值得记一笔）

1. **`expires_in` 实测 599 或 600**，而 [`docs/internals.md:41`](./internals.md#L41) 写成固定的 `600`；
   [`src/device.mjs:80`](../src/device.mjs#L80) 有 `|| 600` 兜底，无影响。
2. **上游多返回一个 `Header` 字段（值 `null`）**，代码不读 —— 无害，但说明「响应字段清单」不是封闭的。
3. **设备码申请不需要 `scope`**：只发 `client_id=cnb_cli` 就返回 `200`，与
   [`src/device.mjs:66-68`](../src/device.mjs#L66-L68) 的写法一致（不用补参数）。
4. 本次跑的时候工作区里 `src/`、`index.mjs`、`README.md`、`CHANGELOG.md`、`tests/` 等**已经是脏的**
   （`git status` 有 9 个 `M`）；这些不是本次改动 —— 本次只新增了
   `scripts/live-verify.mjs` 与 `docs/live-verification.md`。

---

## 6. 这份验证不能证明什么

诚实边界，按「最容易被误读」排序：

1. **假令牌只能验证错误映射，不能证明真登录能成功。**
   设备码流程**从未完成授权**（没人点确认），所以：`access_token` / `refresh_token` 的真实返回、
   `refreshAccessToken()` 的续期、`/user` 的真实响应体（`username` / `id`）、`/user/groups` 与
   `/{org}/-/repos` 的真实形状 —— **全部未验证**。
2. **没有真 CNBSESSION，所以 AI 通道的「成功路径」一次都没走过。**
   没有 200、没有真实 SSE、没有真实 usage 帧、没有长文本流、没有工具调用被上游拒绝的
   真实 403 文案（只有插件提前返回的 501）。`foldSse()` 验证的是「标准 SSE 帧能被正确折叠」，
   不是「CNB 的 SSE 长这样」。
3. **额度那条线完全没验证。** `/{org}/-/charge/quota`、`/volume`、`/special-amount` 的响应体、
   `credit_in_milli` 的单位、徽章（badges）推导、`usage()` 的窗口构造 —— 都需要真 PAT 才能打，
   本次全部没跑。现在它们仍然只有离线测试覆盖。
4. **relay 是本机假中继。** 只证明插件的透传语义（tools 原样转发、头替换、流不读干），
   不证明任何真实网关的行为；也不证明真实上游在 `tools` + `stream:true` 同时出现时的形状
   （脚本里 tools 那条用的是非流式）。
5. **没有装进 magpie、没有接 GUI。** 宿主是不是按这个形状调用、卡片渲染成什么样、
   路由怎么排序，都不在本验证范围内。
6. **没覆盖的分支**：`502 upstream_error` 之外的 HTML 分支（问题 3 说明在路径写错时不可达）、
   `504 upstream_timeout`、`429 rate_limited`、`409 concurrency_conflict` —— 这些都要求上游真的这么回，
   本次没构造出来。
7. **多账号 / 并发没测。** 单进程、单凭据；`refresh-lock` 的并发合并只在离线测试里锁过。
8. **时延不代表最坏情况。** `authorize()` 46ms 是这一次网络条件下的数字，抖动时可能高一个数量级。
9. **上游会变。** 所有状态码、`errmsg`、`csrfkey` 行为都是 **2026-11-02** 的快照；
   文案（`Blocked by CSRF.` / `User has no permission.`）随时可能改。脚本的断言刻意只锁**类别**
   （401/403/是否登录问题）而不锁句子，唯一锁死的字符串是 `authorization_pending`（RFC 8628 的协议值）。

---

## 7. 复跑与维护

- **一条命令**：`node scripts/live-verify.mjs`。实测 8.7 秒，其中 6 秒是**故意**等轮询预算耗尽
  （`maxWaitMs=6000`），不是慢。
- **什么时候该跑**：改 `src/device.mjs` / `src/api.mjs` / `src/chat.mjs` / `src/http.mjs` 之后；
  上游（CNB）发布公告之后；`docs/internals.md` 里的协议事实被引用之前。
- **加新检查**：在脚本里加一个 `async function checkXxx()`，返回 `collector()`，
  推一行到 `CHECKS` 数组即可（编号、名称、证据、问题清单四件套）。
- **失败怎么读**：`✗` 行是结论，下面缩进的 `✗ 具体断言` 是真实差异（实际值 vs 预期值），
  最后一行汇总 `通过 N · 失败 M`。全过退出 0，否则退出 1。
- **别做的事**：不要在脚本里塞真凭据、不要让它写文件、不要让它完成授权 ——
  这三条是这个脚本能长期留在仓库里的前提。

---

## 8. 补充：宿主层验证（2026-11-02，隔离配置，真 magpie 二进制）

第 1～7 节用的是**脚本直接调插件**；这一节补的是「**装进真 magpie、由宿主来调**」。
做法：`HOME` / `XDG_CONFIG_HOME` 指向一个临时目录，让 magpie 读一份空的配置，
你自己的 `~/.config/magpie` 全程没被碰过（`magpie plugin list` 在那个目录下返回
`No plugins.`，证明隔离生效）。

```bash
export HOME=/tmp/magpietest XDG_CONFIG_HOME=/tmp/magpietest/.config
magpie plugin add "<本仓库路径>"
magpie plugin list
magpie plugin login cnb
magpie quota
magpie provider test cnb
```

### 8.1 装载

```
✓ added D:\DeepSeek Harness\反代\magpie-cnb-auth
  cnb (云原生构建 CNB, 8 models)  not signed in · magpie plugin login cnb
```

`magpie plugin list --json` 里 `providers[0]` 的 `usage: true` / `checkin: true` /
`maxConcurrency: 4`、`models` 8 条、`methods` 3 条 —— 宿主认得九个钩子。

### 8.2 设备码登录：完整走完了一次

`magpie plugin login cnb` → 选 1 → 打印
`https://cnb.cool/oauth2/device/verify?user_code=<USER_CODE>` 与「10 分钟内有效」，
浏览器里确认后：

```
✓ signed in to 云原生构建 CNB · its models are cnb/<model>
```

`magpie plugin list` 显示 **`cnb (云原生构建 CNB, 8 models)  signed in as Tlaloc`** ——
注意账号名是**昵称** `Tlaloc`，不是 `GET /user` 里的 `username`（那串是
`cnb.dI2DzHg0QHA`）。这条是第 5 节之后修掉的缺陷，这里是修完后的宿主表现。

`magpie quota` 在「账号没有组织」时给出的是：

```
cnb · Tlaloc  subscription  这个 CNB 账号还没有组织 —— AI Credit 是按组织发放的，
AI 端点也挂在 /{org}/{repo} 下。先到 https://cnb.cool/new/groups 建一个……
```

### 8.3 AI 通道：三种状态下宿主看到什么

| 操作 | 宿主输出 | 说明 |
|---|---|---|
| 账号只有 PAT（默认 `auto`） | `✗ chat  401 · 这条账号还没有 CNBSESSION：CNB 的访问令牌（PAT）调不了模型（上游一律 403 [NO_RIGHT]）……` | 修之前这里是宿主自己拼出来的 **404 Not Found** |
| `transport=relay` 但 `relay.url` 为空 | `✗ chat  400 · 插件选项里把 transport 设成了 relay，但 relay.url 是空的……` | 修之前是 `{}`→宿主拿 `provider.api` 去拼路径 |
| `transport=relay` + 本机假中继 | `✓ chat  7 ms · deepseek-v4.1-flash`；假中继日志收到 `POST /chat/completions ua=yes` | 把中继端口换成没人监听的，同一命令变 `✗ chat 503 · 连不上中继 http://127.0.0.1:34518：ECONNREFUSED` —— A/B 证明请求确实经过插件的 loader |

### 8.4 第 5 节那些问题的处置

| 问题 | 处置 |
|---|---|
| 1 `AGENTS.md` 的函数清单是假的 | 已按真实导出重写 `src/api.mjs` / `src/models.mjs` / `src/chat.mjs` 三行 |
| 2 `looksLoggedIn` 阈值不成立且无人用 | **删掉**，并在 `src/api.mjs` 里写清为什么不能用首页长度判断登录 |
| 3 「路径写错 → 上游回 HTML」 | 已改：`docs/internals.md` 换成实测表（401 `Blocked by CSRF.` / 403 `User has no permission.`） |
| 4 CSRF 重发条件 | 保留行为，注释里写清「同一会话三次抓取返回同值，重发上限 1 次」 |
| 5 `authorize()` 出网 1 次 | **维持现状**：铁律 2 要的是「立刻返回、把等待挪进 `callback`」，实测 46ms / 轮询 0 次已达标；把设备码申请挪进 `callback` 就拿不到 `user_code` 给用户看了 |

### 8.5 这一节同样不能证明什么

- 真实**额度读数**与**真实 SSE 消息**仍然没有：那需要一条有组织、有额度、且手上有
  CNBSESSION 的账号。这一节只证明「宿主这条链路是通的、错误是说人话的」。
- 隔离目录里装的是**本机路径**，不是 `github:` / npm spec —— 分发渠道的安装方式不在此列。

### 8.6 受控浏览器取 Cookie 的管道（2026-11-02 实测）

第 4 条登录路「浏览器网页登录」依赖 `src/browser-login.mjs` 的那套「临时 profile + CDP」。
**管道本身是真的跑通过的**（不是只有单测）：

```
findBrowser() → msedge  C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
spawn(--remote-debugging-port, --user-data-dir=<临时目录>) → 连上 /json/list
Network.enable + Network.getAllCookies → 11 条 Cookie，其中 cnb.cool 的 1 条
  cnb.cool | csrfkey | 长度 32
匿名访问有没有 CNBSESSION：没有（符合预期 —— 它只在登录后才下发）
```

也就是说：**窗口能开、CDP 能连、Cookie 能读**；剩下没被证明的只有「用户在窗口里登录之后，
CNBSESSION 会不会如期出现」——那一步必须要人，脚本没法代替。

另外两条顺带确认的事实：

- **直接读日常浏览器的 Cookie 库行不通**：Edge 正在运行时它的 `Network/Cookies`
  被独占锁定（`cp` 报 `Device or resource busy`、`node:sqlite` 报 `unable to open database file`）。
  所以「不开窗从本机浏览器偷 Cookie」这条路在浏览器开着的时候是死的 —— 受控窗口才是可靠的那条。
- **`POST https://api.cnb.cool/groups` 认不认 Cookie，现在还证不了**：带假 Cookie 与完全不带凭据
  返回的是一模一样的 `401 {"errcode":16,"errmsg":"The task will not run because the user is not logged in."}`。
  `src/org.mjs` 的实现按「形状对、鉴权未知」写，第一次真机跑完请回来更新这一条。

### 8.7 第 4 条登录路：从宿主里真的开出了窗口（2026-11-02/03 实测）

在隔离的 magpie 配置里跑 `magpie plugin login cnb` 并选第 3 条（「浏览器网页登录」），宿主确实：

1. 打出了正确的说明（「先在窗口里登录 cnb.cool，再点页面上的『确认授权』，然后别关窗口」）；
2. **把受控浏览器真的开出来了** —— 进程表里能查到带一次性 profile 的 Edge：

```
msedge.exe 45624 | C:\Users\<user>\AppData\Local\Temp\magpie-login-k2LXTV
msedge.exe 52124 | ...\magpie-login-k2LXTV /prefetch:4
（另有 4 个同 profile 的渲染进程）
```

3. 然后一直等到超时（没人登录），按设计返回「窗口关了但没拿到登录态」。

**这一段证明了**：`authorize() → opened:true → callback() → findBrowser → 受控窗口` 这条链在真宿主里是通的，
窗口用的是临时 profile（`magpie-login-*`），你日常 Edge 的数据没被碰。

**这一段没证明**：登录之后 CNBSESSION 会不会如期出现、确认授权之后设备码那一半会不会拿到 token、
以及登进去之后建组织 / 建仓库那两个请求上游认不认。这四件事都需要人**真的登一次**。

### 8.8 受控窗口打开后，页面到底是什么状态（CDP 实测）

窗口开出来后，直接连它的调试端口看 `/json/list`，拿到两个事实：

**(1) 登录后会回到确认页 —— CNB 自己保留了返回地址**

```
https://cnb.cool/?s_url=https%3A%2F%2Fcnb.cool%2Foauth2%2Fdevice%2Fverify%3Fuser_code%3DYRWiHsXz
```

匿名访问 `oauth2/device/verify?user_code=…` 会被重定向到登录页，并把原地址放在 `s_url` 里。
所以「用户先登录、登录完自动回到确认页」这件事是站点自己做的 —— 插件不需要自己导航，
之前担心的「登录完就回不到确认页」不成立。

**(2) 临时 profile 会先弹一个 Edge 同步确认框，盖住登录页**

```
edge://sync-confirmation-dialog/  |  我们现在正在你的所有设备上同步你的浏览数据
```

新 profile 对 Edge 来说就是「新装」，它先弹这个模态框，用户得点掉才能看到 cnb.cool。
已在 `chromiumLogin` 的启动参数里加 `--disable-sync --disable-features=msEdgeSyncPromo,msEdgeSignInPromo,msImplicitSignin`，
**复测页面数从 2 变 1，同步框消失**（Chrome 会忽略这几个 Edge 专属 feature 名，不影响它）。
