# 插件错误码规范（ERROR-CODES）

> 适用范围：magpie 的所有 provider 插件。本文件是 `HOOKS.md` 第七节「失败处理的层次」的**落地细则**：
> 第七节定的是宿主拿到什么状态码会怎么故障转移，这里定**插件必须怎么产出那个状态码和 code**。
>
> 判据只有一条：**一条错误必须让宿主、agent、用户三方都能做出正确的下一步决定**。

---

## 1. 一条错误必须同时说清三件事

| 字段 | 谁读 | 决定什么 |
|---|---|---|
| **HTTP status**（流式时为错误帧里的 `status`） | magpie 宿主 | 换号 / 换模型 / 退避 / 标账号 / 什么也不做 |
| **`code`** | 程序 | 按词分支（重试、提示、埋点、CI 断言） |
| **`message`** | 人和 agent | 告诉用户到底发生了什么，必须保留上游原文 |

三者缺一，就是一条说不清的错误：

- 只有 message（`throw new Error("AI服务异常")`）→ 宿主不知道该退避还是该换号，只能瞎猜；
- 只有 status（404）→ agent 只能说「模型不可用」，而真实原因可能是「端点不存在」；
- 只有 code → 用户看不懂。

```json
// 正确形状（OpenAI 兼容错误体）
{ "error": { "message": "...", "type": "upstream_error", "code": "upstream_timeout", "status": 504 } }
```

`type` 是上游厂商给的错误类别（能拿到就填），`code` 是本规范定义的稳定词表，`status` 是宿主判据。

---

## 2. 状态码 → 宿主行为（唯一真源）

| status | magpie 的行为 | 什么情况才用 | 什么情况**不许**用 |
|---|---|---|---|
| **400** | 不换号、不换模型，原样透出 | 参数错误、schema 不合法、**内容被上游风控拦** | 上游故障（会被当成请求问题，用户以为改 prompt 就行） |
| **401** | 标记这个账号、从路由里摘掉 | 确实是登录失效 | 非登录问题的 401（用 `X-Magpie-Sign-In: kept`）；上游超时 |
| **409** | 原样透出，可退避 | 同账号并发撞车（资源已存在） | 一般错误 |
| **429** | 原样透出，退避/冷却 | 限流、账号冷却 | 上游崩溃 |
| **404** | **只搁置这个模型** | **只有**「模型不存在 / 该模型不可用」 | 端点不存在、上游超时、上游 5xx（会被当成模型坏了，去换一个同样坏的模型） |
| **501** | 原样透出 | 不支持的端点/能力 | 模型不存在 |
| **502** | 换号/换模型继续 | 上游返回了明确的错误体（业务错误） | 超时、暂时不可用（不可重试的错误被当可重试，会反复撞墙） |
| **503** | 原样透出，自动换号/模型 | 上游 5xx、暂时不可用 | 内容问题 |
| **504** | 原样透出，自动换号/模型 | 上游/网关**等待超时**、流被截断、整轮墙钟到点 | 业务错误 |

> 原则：**5xx 只表示「上游那边出事了，重试有意义」；4xx 只表示「这次请求本身有问题，重试没用」。**
> 把 5xx 写成 4xx，用户会去改 prompt；把 4xx 写成 5xx，宿主会把账号全部换一遍还是失败。

---

## 3. error code 词表（v1 · 冻结）

`code` 是机器读的稳定标识，**只能取下列值**。加码要改本文件并升 v2，不许各插件自己造词。

| code | 配套 status | 可重试 | 换号有救 | 含义 | 典型触发 |
|---|---|---|---|---|---|
| `sign_in_required` | 401 | ❌ | ❌（要人重新登录） | 没有凭据 / 从未登录 | 插件拿不到 cookie |
| `session_expired` | 401 | ❌ | ✅ | 凭据失效 | 上游回 401/403，空 body |
| `audit_blocked` | 400 | ❌ | ❌ | 内容被上游风控拦 | `AuditFailed` / 「暂时无法回答此问题」 |
| `invalid_request` | 400 | ❌ | ❌ | 参数或 schema 不合法 | 上游 `400 InvalidArgument` |
| `model_not_found` | 404 | ❌ | 换模型 ✅ | 模型不存在或该模型不可用 | 上游明确说不认识这个 model_id |
| `concurrency_conflict` | 409 | ✅（退避） | ❌ | 同账号并发撞车 | 上游 `409 资源已存在` |
| `rate_limited` | 429 | ✅（退避） | ✅ | 限流 / 账号冷却 | 上游 429 |
| `upstream_unavailable` | 503 | ✅ | ✅ | 上游 5xx、暂时不可用 | 上游 500/502/503 |
| `upstream_timeout` | 504 | ✅ | ✅ | 等待超时 / 流被截断 / 整轮墙钟到点 | 空闲看门狗、墙钟、`响应被截断` |
| `upstream_error` | 502 | ❌ | ✅ | **默认桶**：上游给了明确错误体，但不属于上面任何一类 | 上游业务错误、未知 code |
| `internal_error` | 502 | ❌ | ❌ | **插件自身**的问题（bug / 宿主契约不符） | 上游没返回 `session_id`、解密失败、字段缺失 |
| `not_implemented` | 501 | ❌ | ❌ | 不支持的端点或能力 | `GET /v1/embeddings` |

**`internal_error` 必须和 `upstream_error` 分开**：前者是「我们的问题，报给作者」，后者是「上游的问题，换号试试」。混在一起，永远没人修插件。

---

## 4. 硬性规则（R1–R9）

| 编号 | 规则 | 怎么检查 |
|---|---|---|
| **R1** | 每个错误响应必须显式带 `code`，禁止依赖默认值 | 静态扫描 `errorResponse(` 的第 3 个参数 |
| **R2** | `code` 必须来自 §3 词表 | 静态扫描字符串字面量 |
| **R3** | 禁止裸 `throw new Error(...)` 直接进聊天通道；必须是 `upstreamError(message, status)` 或经过统一分类 | 静态扫描 `throw new Error(` 是否在 `loader.fetch` 可达路径 |
| **R4** | `404` 只能用于「模型不存在」 | 静态扫描 `404` 出现上下文 |
| **R5** | 非登录问题的 401 必须带 `X-Magpie-Sign-In: kept` | 静态扫描 401 分支 |
| **R6** | 流式错误帧必须同时带 `code` 和 `status` | 静态扫描 SSE `fail(...)` |
| **R7** | `message` 必须保留上游原文（可以加中文前缀），不许只写「服务异常」这类无信息量的话 | 人工评审 + 静态扫描空泛措辞 |
| **R8** | 超时类必须落 503/504，不许落 502/404 | 静态扫描 |
| **R9** | 词表里每个 code 至少有一条测试 | 扫描 `tests/` 里的断言 |

> R7 单独强调：`灵犀上游返回 AIError：AI服务异常` 这条错误就违反了 R7 —— 用户和作者都无法从「AI服务异常」得知是超时、限流还是崩溃。
> 正确写法至少是 `灵犀上游单轮已跑 310 秒仍未完成（运行时 300 秒硬限）`。

---

## 5. 流式（SSE）通道的特殊规则

流式一旦以 `200` 开头，**状态码就改不了了**。所以：

1. 错误帧格式固定：
   ```
   data: {"error":{"message":"...","type":"upstream_error","code":"upstream_timeout","status":504}}
   ```
2. **`status` 字段必须有** —— 这是宿主唯一能拿到的判据；
3. 错误帧之后必须 `controller.close()`，不许直接断流（断流会被当成「正常结束」）；
4. 已经发出正文/工具调用之后，**不许自动重试**（会重复内容），只能如实报错；
5. 还没发任何字节时，允许在同一条上游 run 上重试一次；重试仍失败，错误 message 里要写清「已重试 N 次」。

---

## 6. 最小实现模板（照抄）

```js
// ── 错误码词表（与 ERROR-CODES.md §3 保持一致）──────────────
const CODES = Object.freeze({
  signInRequired: "sign_in_required",
  sessionExpired: "session_expired",
  auditBlocked: "audit_blocked",
  invalidRequest: "invalid_request",
  modelNotFound: "model_not_found",
  concurrencyConflict: "concurrency_conflict",
  rateLimited: "rate_limited",
  upstreamUnavailable: "upstream_unavailable",
  upstreamTimeout: "upstream_timeout",
  upstreamError: "upstream_error",
  internalError: "internal_error",
  notImplemented: "not_implemented",
});

// ── 打错误：所有出口都从这里过 ──────────────────────────────
function upstreamError(message, status = 0) {
  const text = String(message ?? "");
  const error = new Error(text);
  if (status) error.status = status;
  return error;
}

// 机器读 code：按 status 和标记字段分类，不许自由发挥
function errorCode(error) {
  if (error?.audit) return CODES.auditBlocked;
  if (error?.internal) return CODES.internalError;
  if (error?.runtimeDeadline || error?.idle) return CODES.upstreamTimeout;
  const status = Number(error?.status) || 0;
  if (status === 400) return CODES.invalidRequest;
  if (status === 404) return CODES.modelNotFound;
  if (status === 409) return CODES.concurrencyConflict;
  if (status === 429) return CODES.rateLimited;
  if (status === 501) return CODES.notImplemented;
  if (status === 503) return CODES.upstreamUnavailable;
  if (status === 504) return CODES.upstreamTimeout;
  return CODES.upstreamError;
}

// 宿主判据：把「我们内部的语义」翻译成「宿主认识的状态码」
function chatErrorStatus(error) {
  const status = Number(error?.status) || 0;
  if (error?.audit) return 400;              // 换号没用
  if (status === 401 || status === 403) return 401;
  if (status === 409) return 409;
  if (status === 429) return 429;
  if (status === 400 || status === 404 || status === 422) return 404 === status ? 404 : 400;
  return status >= 500 ? status : 502;
}

// 非登录问题的 401：告诉宿主「别标账号」
function signInHeaders(error) {
  const status = Number(error?.status) || 0;
  if (status !== 401 && status !== 403) return {};
  const text = String(error?.message || "");
  const authish = /unauthor|登录|凭据|credential|cookie|sid|token/i.test(text) || /[:：]$/.test(text);
  return authish ? {} : { "X-Magpie-Sign-In": "kept" };
}

// 流式错误帧：code + status 一个都不能少
const fail = (controller, error) => {
  const payload = {
    error: {
      message: error.message,
      type: "upstream_error",
      code: errorCode(error),
      status: chatErrorStatus(error),
    },
  };
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
  controller.close();
};
```

---

## 7. 检查

```bash
node scripts/check-error-codes.mjs <插件目录>
```

检查项对应 §4 的 R1–R8，输出：

```
✓ R1 每个 errorResponse 都带了 code（12 处）
✓ R2 code 全在词表内
✗ R4 发现 404 用在「不支持的端点」：index.mjs:2430 —— 应改为 501 + not_implemented
```

它是**静态近似**，抓的是形态不是语义；语义最终靠人工评审确认。但形态错了，语义基本也错。

---

## 8. 验收清单（交付前逐条勾）

- [ ] 每个错误出口都带 `status` + `code` + 有信息量的 `message`（R1、R7）
- [ ] 所有 `code` 在 §3 词表内（R2）
- [ ] 聊天通道里没有裸 `throw new Error`（R3）
- [ ] `404` 只出现在「模型不存在」（R4）
- [ ] 非登录问题的 401 带 `X-Magpie-Sign-In: kept`（R5）
- [ ] 流式错误帧带 `status`（R6）
- [ ] 超时类落 503/504（R8）
- [ ] 词表里**每一个** code 都有测试（R9）
- [ ] 有一条测试专门断言「这个错误不会被映射成 404 / 401」
- [ ] README 的错误说明与本文件一致

---

## 9. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1 | 2026-11-02 | 首版。起因：WPS 灵犀插件把「整轮 310 秒超时」报成 `upstream_error`（502），宿主既不换号也不退避；排查时还发现「不支持的端点」用 404，会被当成模型坏了。 |
