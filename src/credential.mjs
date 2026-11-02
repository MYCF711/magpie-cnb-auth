// src/credential.mjs —— 「用户到底给了我什么？」+「这个账号现在能干什么？」
//
// magpie 有三条登录路（见 index.mjs 的 auth.methods），落下来的凭据形状只有两种：
//
//   访问令牌（PAT / `~/.cnb/token` 里的 access_token）  以 `cnb_at_` / `cnb_rt_` 开头，
//                                                        90+ 字符，打的是 api.cnb.cool
//   CNBSESSION（浏览器 Cookie）                          三段：数字.数字.<长 hex>，
//                                                        打的是 cnb.cool 网页侧
//
// ⚠ 粘贴方式（`type: "api"`）在 `authorize` 里拿不到用户在输入框里填的值 ——
//   magpie 宿主只把 `prompts` 的答案作为 `inputs` 传进来（internal/plugin/host.js）。
//   所以「这是 PAT 还是 CNBSESSION」**只能在运行时识别**，而且必须一次识别、
//   按凭据本身缓存 —— 缓存键是凭据，不是 provider id，否则多账号会串。

import { createHash } from "node:crypto"

import { fetchTopGroups, fetchUser, listRepos } from "./api.mjs"

/** 一条凭据的「长相」。粘错东西时光说「无效」等于什么都没说。 */
export function describeCredentialShape(raw) {
  const v = String(raw || "").trim()
  const segs = v.split(".")
  return {
    length: v.length,
    hasAccessTokenPrefix: /^cnb_(at|rt)_/.test(v),
    hasDot: segs.length > 1,
    segments: segs.length,
    sessionLike: segs.length === 3 && /^\d+$/.test(segs[0]) && /^\d+$/.test(segs[1]) && /^[0-9a-fA-F]{16,}$/.test(segs[2] || ""),
  }
}

/** 把 shape 翻译成一句人话，塞进错误信息里。 */
export function explainCredentialShape(shape) {
  const parts = [`你给的是 ${shape.length} 个字符`]
  if (shape.hasAccessTokenPrefix) parts.push("带 cnb_at_ / cnb_rt_ 前缀")
  else if (shape.sessionLike) parts.push("看着像 CNBSESSION")
  else if (!shape.hasDot) parts.push("没有点号分段")
  else parts.push(`${shape.segments} 段`)
  return parts.join("、")
}

/** 凭据的稳定指纹 —— 只用来区分账号，不参与鉴权。 */
export function fingerprint(raw) {
  return createHash("sha256").update(String(raw || "")).digest("hex").slice(0, 12)
}

/**
 * 按「长相」给一个初判。**不做网络请求** —— 形态判断只用来决定先说哪句话。
 * `unknown` 表示两种都不像；真正是什么，由 `identifyCredential()` 打一次接口定。
 */
export function shapeKind(raw) {
  const shape = describeCredentialShape(raw)
  if (shape.hasAccessTokenPrefix) return { kind: "pat", shape }
  if (shape.sessionLike) return { kind: "session", shape }
  return { kind: "unknown", shape }
}

// 缓存键是**凭据本身**。用 provider id 当键会让同一渠道的第二个账号读到第一个的结果。
const credentialCache = new Map()

/** 测试用：清空缓存。 */
export function clearCredentialCache() {
  credentialCache.clear()
}

/**
 * 识别一条凭据，并把它「能做什么」一次算清楚。
 *
 * 识别顺序是**先真的打一次接口**，不靠形态猜：
 *   ① 当访问令牌打 `/user` → 200 就是 PAT，顺便拿到 username 与组织
 *   ② 不行再当 CNBSESSION 抓首页 → 登录态首页 200KB+
 *   ③ 都不是 → 抛出带「你给的是什么」的错误
 *
 * @returns {Promise<{kind:"pat"|"session", token?:string, session?:string, username:string, org:string, repo:string, groups:string[], repos:string[], shape:object}>}
 */
export async function identifyCredential(raw, { signal, options } = {}) {
  const value = String(raw || "").trim()
  if (!value) {
    const error = new Error("没有 CNB 凭据")
    error.status = 401
    error.signIn = "expired"
    throw error
  }

  const shape = describeCredentialShape(value)

  // 形状已经足够互斥时，**先按形状走** —— 拿 CNBSESSION 去打 api.cnb.cool 必然 401，
  // 白跑一次还多一条超时风险；反过来访问令牌也没有点号分段。
  // 只有「两种都不像」时才按「先当令牌试一次」处理。
  const tryPatFirst = !shape.sessionLike

  if (tryPatFirst) {
    // ① 当访问令牌
    try {
      const user = await fetchUser(value, { signal })
      if (user && (user.username || user.id)) {
        const groups = await fetchTopGroups(value, { signal })
        const org = String(options?.org || groups[0]?.path || "").replace(/^\/+|\/+$/g, "")
        const repos = org ? await listRepos(value, org, { signal }) : []
        return {
          kind: "pat",
          token: value,
          username: String(user.username || ""),
          userId: String(user.id || ""),
          org,
          groups: groups.map((g) => g.path),
          repos,
          shape,
        }
      }
    } catch (error) {
      // 401 / 403 才继续往下试；其它错误（网络断了）直接抛，
      // 别把「连不上 api.cnb.cool」说成「凭据无效」。
      const status = Number(error?.status) || 0
      if (status && status !== 401 && status !== 403) throw error
    }
  }

  // ② 当 CNBSESSION
  if (shape.sessionLike) {
    return {
      kind: "session",
      session: value,
      username: "",
      org: String(options?.org || "").replace(/^\/+|\/+$/g, ""),
      groups: [],
      repos: [],
      shape,
    }
  }

  // ③ 都不是 —— 说清楚他粘的是什么
  const error = new Error(
    `粘贴的凭证无效：${explainCredentialShape(shape)}。` +
      `CNB 访问令牌以 cnb_at_ 开头、90 多字符；CNBSESSION 是三段（数字.数字.<长 hex>）。` +
      `到 https://cnb.cool/profile/token 生成一个，或直接点「浏览器授权登录」，连粘都不用。`,
  )
  error.status = 401
  error.signIn = "expired"
  throw error
}

/**
 * 拿（或建）这个账号的运行时档案。
 *
 * ⚠ **只读，不写盘**：插件对 magpie 的目录只有读的份；这里也不写 `~/.cnb/token`
 *   （写回只在 refresh 路径里、且要先确认归属，见 index.mjs 的 auth.refresh）。
 */
export async function ensureCredential(auth, { signal, options } = {}) {
  const raw = rawCredentialOf(auth)
  if (!raw) return { kind: "empty", username: "", org: "", repo: "", groups: [], repos: [] }

  const cached = credentialCache.get(raw)
  if (cached) return cached

  const record = await identifyCredential(raw, { signal, options })
  credentialCache.set(raw, record)
  return record
}

/**
 * 同步读一份「不上网也能知道」的档案：登录时已经存进 auth 的字段优先。
 * 用在 loader 里 —— 那里每次请求都跑，不能每次重打接口。
 */
export function resolveAccount(auth, options = {}) {
  const raw = rawCredentialOf(auth)
  const cached = raw ? credentialCache.get(raw) : null
  const meta = auth?.metadata && typeof auth.metadata === "object" ? auth.metadata : {}

  const kind = cached?.kind || (auth?.type === "oauth" ? "pat" : meta.kind) || shapeKind(raw).kind
  // ⚠ 优先级：**显式选项 > 登录时探测到的**。反过来的话，用户在选项里改了 org / repo，
  //   缓存里那份旧值会一直赢 —— 表现是「改了设置没生效」。
  const org = String(options.org || cached?.org || meta.org || "").replace(/^\/+|\/+$/g, "")
  // repo **每次都重算**：它随选项和仓库列表变，不该被烘进按凭据缓存的档案里。
  const repo = pickRepo(cached?.repos || [], meta.repo || "", { ...options, org })

  return {
    kind,
    raw,
    token: kind === "pat" ? raw : "",
    session: kind === "session" ? raw : String(meta.session || ""),
    csrfkey: String(cached?.csrfkey || meta.csrfkey || ""),
    username: String(cached?.username || meta.username || auth?.accountId || ""),
    org,
    repo,
    groups: cached?.groups || [],
    repos: cached?.repos || [],
  }
}

/** magpie 的 auth 对象里，凭据可能落在 `access`（oauth）或 `key`（api）上。 */
export function rawCredentialOf(auth) {
  if (!auth) return ""
  const value = auth.access || auth.key || auth.token || ""
  return String(value || "").trim()
}

/** 这个账号的身份标识：优先厂商自己的 user id，其次凭据指纹（**不要拿名字当身份**）。 */
export function uidOf(auth, record) {
  const meta = auth?.metadata && typeof auth.metadata === "object" ? auth.metadata : {}
  return String(record?.userId || meta.userId || auth?.uid || (rawCredentialOf(auth) ? fingerprint(rawCredentialOf(auth)) : ""))
}

/**
 * 仓库路径 —— AI 通道的 URL 里必须有它。
 *
 * 判据：显式配置 > 登录时探测到的 > 猜 `<org>/<repoName>`。
 * 猜是最后一档，因为猜错会变成「上游回 HTML 404」，用户看到的是「登录过期」。
 */
export function pickRepo(repos, snapshot, options = {}) {
  const explicit = String(options?.repo || "").replace(/^\/+|\/+$/g, "")
  if (explicit) return explicit

  const snap = String(snapshot || "").replace(/^\/+|\/+$/g, "")
  const list = Array.isArray(repos) ? repos : []
  if (snap && list.some((r) => r === snap || r.endsWith("/" + snap.split("/").pop()))) return snap

  const first = list.find((r) => r && r.includes("/")) || list[0] || ""
  if (first) return String(first).replace(/^\/+|\/+$/g, "")

  const org = String(options?.org || "").replace(/^\/+|\/+$/g, "")
  return org ? `${org}/${options?.repoName || "code"}` : ""
}

/** 卡片的账号名：**名字**，不是内部 ID（HOOKS 坑 27）。取不到就是空串，宿主回退供应商名。 */
export function accountNameOf(record, auth) {
  const name = String(record?.username || "").trim()
  if (name) return name
  const stored = String(auth?.accountId || "").trim()
  return stored
}
