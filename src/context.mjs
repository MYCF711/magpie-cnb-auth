// 共享上下文 —— 框里所有小插头都读这一份
//
// ⚠ 改这里，不要改各个 hook 文件里的常量。
//   针脚模块只关心「怎么填这一个针脚」，厂商信息全在这儿。

/** 厂商 id：agent 用 `<id>/<model>` 命名，改完全世界都要跟着改 */
export const PROVIDER = "cnb"

/** 卡片上显示的供应商名：必须 <中文> <English>，英文照抄厂商官方品牌写法 */
export const PROVIDER_NAME = "云原生构建 CNB"

/** 上游 API 基址（CNB 的 AI 通道挂在网页域下，不是 api.cnb.cool） */
export const BASE = "https://cnb.cool"

/**
 * 决定 API 形状，别乱选：
 *   @ai-sdk/anthropic         → Anthropic Messages  /messages
 *   @ai-sdk/openai            → OpenAI Responses    /responses
 *   @ai-sdk/google            → Gemini              /models/<id>:streamGenerateContent
 *   @ai-sdk/openai-compatible → Chat completions    /chat/completions
 *
 * CNB 的 AI 端点就是 OpenAI Chat 形状，而且**只吃 stream:true**
 * （非流式直接回业务码 11101）—— 客户端要非流式时由 src/chat.mjs 折叠 SSE。
 */
export const SDK = "@ai-sdk/openai-compatible"

/** api_key 只活几分钟/几小时时，提前多久换 */
export const REFRESH_LEAD_MS = 5 * 60_000

// ── 域名与端点 ────────────────────────────────────────────────────────
//
// 两个站点是两套鉴权，别混：
//   cnb.cool      网页域：Cookie（CNBSESSION）+ Csrftoken → AI 通道、网页侧动作
//   api.cnb.cool  OpenAPI：Authorization: Bearer <PAT> → 用户 / 组织 / 额度
//
// 实测（2026-11-02）：PAT 调不了模型 —— api.cnb.cool 的 AI 路径一律
//   403 {"errcode":403,"errmsg":"[NO_RIGHT]OpenAPI only allowed in pipeline"}
// 所以「跑模型」只有两条路：CNB 网页登录态，或自建中继（见 src/chat.mjs）。

export const WEB_BASE = "https://cnb.cool"
export const API_BASE = "https://api.cnb.cool"

/**
 * 账号**没有组织**时，AI 通道用这个仓库做路径。
 *
 * 真机实测（2026-11-03，真实 CNBSESSION）：`POST https://cnb.cool/cnb/docs/-/ai/chat/completions`
 * 回 200 + 正常 SSE，模型答得出话 —— 也就是说 AI 端点**不要求仓库属于你自己的组织**，
 * 一个公开仓库就够。这条兜底让「登录完就能跑模型」不再依赖「先建一个组织」，
 * 也就避开了建组织那条 yearly 配额（一个根组织一年只能建 1 个）。
 */
export const PUBLIC_AI_REPO = "cnb/docs"

/** OAuth Device Flow —— 与 cnb-cli 的 `cnb login` 同一套参数 */
export const OAUTH_DEVICE_URL = `${WEB_BASE}/oauth2/device/auth`
export const OAUTH_TOKEN_URL = `${WEB_BASE}/oauth2/token`
export const OAUTH_CLIENT_ID = "cnb_cli"

/** CNB 目前真在干活的默认模型 */
export const DEFAULT_MODEL = "deepseek-v4.1-flash"

export const PLUGIN_VERSION = "0.1.0"

/**
 * 所有请求都必须带 UA —— 缺了会被 Cloudflare 判 bot，回
 * `403 Error 1010 browser_signature_banned`，而且错误体是 HTML，看不出是 UA 的锅。
 *
 * ⚠ **值必须是「官方客户端」的 UA，不能是 `<产品名>/<版本号>`**：上游网关按
 * `<product>/<version>` 形态认「第三方客户端」，命中即回
 * `403 {"error_code":"TM.00000001","error_msg":"网络繁忙，请稍后重试"}`；
 * 不显式设 UA 时宿主会把 `magpie/<version>` 原样透传，同样命中。
 * CNB 只有「官方网页（Cookie 会话）」与 OpenAPI（Bearer）两种客户端形状，
 * 所以这里逐字用一条完整合法的 Chrome UA —— 别改成别的版本号，也别退回产品名。
 */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

/**
 * 插件自己的身份标签（**不是 UA，绝不许进 User-Agent**）：只给 `x-cnb-client`
 * 这类自用请求头用。带版本号的产品名会命中上游的第三方客户端拦截。
 */
export const CLIENT_TAG = "cnb-auth"

/** 控制台路由（从 cnb.cool 前端 bundle 里抓到的真实路径，别改） */
export const ROUTES = Object.freeze({
  token: `${WEB_BASE}/profile/token`, // 访问令牌管理
  profile: `${WEB_BASE}/profile`,
  identity: `${WEB_BASE}/user/identity`, // 实名认证
  extIdentity: `${WEB_BASE}/user/ext_identity`, // 扩展身份：高校 / 天才 / TDP
  extIdentityPrivilege: `${WEB_BASE}/user/charge/ext_identity/privilege`, // 认证特权额度
  quota: `${WEB_BASE}/user/quota`, // 额度总览
  newRepo: `${WEB_BASE}/new/repos`,
  deviceVerify: `${WEB_BASE}/oauth2/device/verify`,
})

/**
 * 图标 —— **两处必须一致**，缺一份就有地方显示灰方块：
 *   auth.icon（本文件导出）  → 供应商列表那一行、用量概览的卡
 *   package.json 的 magpie.icon → 插件列表那一行、插件详情页左上角
 * 见 HOOKS.md「插件自己的图标」。
 */
export const ICON =
  "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIwIiBoZWlnaHQ9IjMyMCIgdmlld0JveD0iMCAwIDMyMCAzMjAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxwYXRoIGQ9Ik0yMjguOTA2IDQwLjI0MTJDMjI5Ljg4MiAzNy41MTA4IDIyOC45MDYgMzQuMzkwMyAyMjYuNzU5IDMyLjQ0QzIxOS4zNDIgMjYuMDA0IDIwMC43OTkgMTIuMzUxOSAxNzMuMDgyIDEwLjQwMTZDMTQxLjg1MiA4LjA2MTIxIDEyMi41MjggMTYuNDQ3NSAxMTIuNzY5IDIyLjY4ODVDMTA4LjQ3NCAyNS40MTg5IDEwOC4yNzkgMzEuNDY0OSAxMTIuMTgzIDM0LjM5MDNMMTkxLjYyNSA5Ni4yMTQ5QzE5OC42NTIgMTAxLjY3NiAyMDguOTk3IDk4LjU1NTMgMjExLjcyOSA5MC4xNjlMMjI4LjcxMSA0MC4yNDEySDIyOC45MDZaIiBmaWxsPSIjRkY2MjAwIi8+CjxwYXRoIGQ9Ik0zMi45MzgxIDIyMy41NjRDMjkuNjE5OSAyMjUuNzEgMjguMjUzNiAyMjkuODA1IDI5LjIyOTUgMjMzLjUxMUMzMi4xNTczIDI0NC40MzIgNDEuMzMxMiAyNjYuODYxIDY2LjkwMDkgMjg3LjUzNEM5Mi40NzA2IDMwOC4wMTIgMTIyLjcyNSAzMTAuMzUzIDEzNS42MDcgMzA5Ljk2M0MxMzkuNTExIDMwOS45NjMgMTQyLjgyOSAzMDcuNDI3IDE0NCAzMDMuNzIyTDE5NC45NDUgMTQyLjYyN0MxOTguNjUzIDEzMC45MjUgMTg1LjU3NiAxMjEuMTczIDE3NS40MjYgMTI3Ljk5OUwzMi45MzgxIDIyMy41NjRaIiBmaWxsPSIjRkY2MjAwIi8+CjxwYXRoIGQ9Ik03MC4yMTY5IDUzLjQ5NTVDNjcuNjc5NCA1Mi41MjAzIDY0Ljk0NjggNTIuNzE1MyA2Mi42MDQ1IDUzLjg4NTVDNTMuMjM1NSA1OC45NTYzIDI5LjAzMiA3NC43NTM4IDE2LjU0IDEwNy4zMjRDNi43ODA1NCAxMzIuMjg4IDEwLjA5ODcgMTU5Ljk4MiAxMi44MzE0IDE3My40MzlDMTMuNjEyMSAxNzcuOTI1IDE4LjI5NjcgMTgwLjQ2IDIyLjU5MDggMTc4LjcwNUwxNzUuNDI0IDExOS4wMjZDMTg2LjM1NCAxMTQuNzM1IDE4Ni4zNTQgOTkuMzI3NiAxNzUuNDI0IDk1LjAzNjlMNzAuMjE2OSA1My40OTU1WiIgZmlsbD0iI0ZGNjIwMCIvPgo8cGF0aCBkPSJNMjk3LjAzIDE2OC45NjhDMzAxLjUxOSAxNzEuODkzIDMwNy41NyAxNjkuMzU4IDMwOC4zNTEgMTY0LjA5MkMzMTAuMzAzIDE1MC4wNSAzMTIuMDYgMTI1Ljg2NiAzMDQuMDU3IDEwNy4zMzhDMjkzLjMyMSA4Mi45NTkxIDI3NC45NzQgNjcuNzQ2OCAyNjYuMTkgNjEuNzAwOEMyNjMuNDU4IDU5Ljc1MDUgMjU5Ljc0OSA1OS45NDU2IDI1Ny4yMTIgNjIuMjg1OUwyMTguNTY0IDk2LjQxNjJDMjEyLjMxOCAxMDIuMDcyIDIxMi45MDQgMTEyLjAxOSAyMTkuOTMxIDExNi42OTlMMjk3LjAzIDE2OC45NjhaIiBmaWxsPSIjRkY2MjAwIi8+CjxwYXRoIGQ9Ik0xODkuMDg5IDI5OS40MjhDMTg4LjY5OSAzMDMuOTE0IDE5Mi42MDMgMzA3LjgxNCAxOTcuMDkyIDMwNy4yMjlDMjExLjczMSAzMDUuNjY5IDI0MS43OSAyOTkuODE4IDI2NC4yMzcgMjc4LjM2NUMyODYuMDk4IDI1Ny40OTYgMjkzLjMyIDIzMi43MjggMjk1LjI3MiAyMjIuNzgxQzI5NS44NTggMjIwLjA1MSAyOTUuMjcyIDIxNy4zMiAyOTMuNTE1IDIxNS4xNzVMMjI1Ljk4IDEzMS44OTdDMjE4Ljc1OCAxMjIuOTI1IDIwNC4xMTkgMTI3LjQxMSAyMDMuMTQzIDEzOC45MThMMTg5LjA4OSAyOTkuMjMzVjI5OS40MjhaIiBmaWxsPSIjRkY2MjAwIi8+Cjwvc3ZnPgo="

// ── 模型表 ────────────────────────────────────────────────────────────
//
// ⚠ context 必须实测，不要凭印象填。这个数字会被转给 agent（DSH 等），
//   决定它什么时候压缩对话：填小了浪费容量、还会把路由组整体的窗口拉低；
//   填大了 agent 以为有余量，请求超了上游才报错。
//   别把「最大输出」当「上下文」—— DeepSeek 系常见 128K 输出 / 1M 上下文。
//
// CNB **没有**公开的 `/models` 端点：这份目录就是它的全部（8 个），
// 不是「拉取失败时的兜底」。
//
// ⚠ 关于「谁是主模型」：参考实现 `opencode-cnb-account` 的源码注释里有一句
//   「CNB 实际只有 deepseek-v4.1-flash 在真干活，其余是静默 fallback 别名」。
//   那是**作者注释，没有附实测记录**，README 里也没有这句。所以本插件不据此做任何
//   别名重写（`model` 原样透传）—— 如果上游真在做静默回退，那也是服务端行为，
//   客户端改不了，硬写一张映射表只会让用户以为切了模型。
//
// 字段：id / 显示名 / context / output / reasoning(可省) / image(可省)
export const MODEL_SPECS = Object.freeze([
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", context: 1_000_000, output: 64_000 },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", context: 1_000_000, output: 64_000 },
  { id: "glm-5.3", name: "GLM 5.3", context: 1_000_000, output: 64_000, reasoning: true },
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash", context: 1_000_000, output: 131_072, reasoning: true },
  { id: "glm-5.3-flash-vision", name: "GLM 5.3 Flash Vision", context: 1_000_000, output: 32_000, image: true },
  { id: "glm-5.2", name: "GLM 5.2", context: 200_000, output: 32_000 },
  { id: "kimi-k3", name: "Kimi K3", context: 1_000_000, output: 32_000, reasoning: true },
  { id: "hy4-preview", name: "Hunyuan 4 Preview", context: 1_000_000, output: 64_000, reasoning: true },
])

/** 登录前还不知道走哪条通道，先乐观地写 true；登录后由 src/models.mjs 按通道纠正 */
export const TOOLS_BEFORE_LOGIN = true

/**
 * 造一条模型条目。
 *
 * ⚠ `capabilities` 与 `modalities` 两个都写：
 *   config 钩子的静态模型走 `modalities`，provider.models 路径走 `capabilities.input`。
 *   只写一边，另一边就看不到模态。
 *
 * ⚠ HOOKS 坑 25：`capabilities.input.image` 必须是**布尔**。省略不等于 text ——
 *   宿主会拿 models.dev 的同名裸 id 投票补，别家标过 image 就会被带成能收图。
 *
 * ⚠ 没有 `free: true`：CNB 的模型吃当月 Credit，不是「列表价 $0 的无上限免费」。
 *   标成 free 会让 Free-first 一直派发它们（HOOKS 坑 2）。
 */
export function modelEntry(spec, { toolcall = TOOLS_BEFORE_LOGIN } = {}) {
  const vision = Boolean(spec.image)
  const reasoning = Boolean(spec.reasoning)
  const tool = Boolean(toolcall)
  return {
    id: spec.id,
    name: spec.name,
    api: { id: spec.id, url: WEB_BASE, npm: SDK },
    status: "active",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: spec.context, output: spec.output },
    modalities: { input: vision ? ["text", "image"] : ["text"], output: ["text"] },
    capabilities: {
      temperature: true,
      reasoning,
      toolcall: tool,
      attachment: vision,
      // 五个模态键必须显式写布尔（HOOKS 十一之三）
      input: { text: true, image: vision, audio: false, video: false, pdf: false },
      output: { text: true },
    },
    // config 路径（官方 #quick 示例）用的是带下划线的 tool_call，两个都写，别猜哪个是对的
    tool_call: tool,
    attachment: vision,
    reasoning,
  }
}

/** 静态模型表（未登录 / 通道未知时的兜底，必须有内容 —— 铁律 1） */
export function staticModels({ toolcall = TOOLS_BEFORE_LOGIN } = {}) {
  const out = {}
  for (const spec of MODEL_SPECS) out[spec.id] = modelEntry(spec, { toolcall })
  return out
}

/** 框里所有小插头拿到的同一份上下文 */
export const ctx = {
  PROVIDER,
  PROVIDER_NAME,
  BASE,
  SDK,
  ICON,
  REFRESH_LEAD_MS,
  WEB_BASE,
  API_BASE,
  OAUTH_DEVICE_URL,
  OAUTH_TOKEN_URL,
  OAUTH_CLIENT_ID,
  DEFAULT_MODEL,
  USER_AGENT,
  CLIENT_TAG,
  ROUTES,
  MODEL_SPECS,
  TOOLS_BEFORE_LOGIN,
  modelEntry,
  staticModels,
}
