// magpie-cnb-auth —— 云原生构建 CNB 的供应商插件
//
// 这个文件**只做装配**：九个钩子各挂一个实现，实现全在 src/。
// 想改某个钩子的行为，去改 src/ 里对应的那个文件，不要在这里加逻辑。
//
// ─────────────────────────────────────────────────────────────────────
// 九项清单
// ─────────────────────────────────────────────────────────────────────
//   ① config(cfg)                       声明 provider + 静态模型表
//   ② auth.methods[].authorize()        登录（四条路：设备码 / 本机 cnb-cli / 受控浏览器 / 粘贴）
//   ③ auth.refresh(auth, provider)      续期（OAuth refresh_token）
//   ④ auth.loader(getAuth, provider)    请求接管（cookie 直连 或 relay 中继）
//   ⑤ auth.usage(getAuth, provider)     额度 → 卡片进度条（当月 AI Credit）
//   ⑥ auth.checkin(getAuth, provider)   签到（CNB 没有，默认 inactive）
//   ⑦ provider.models(provider,{auth})  每账号目录（按通道纠正 toolcall）
//   ⑧ "chat.headers"(input, output)     每请求加头
//
//   ⑨ accountId / uid / icon / maxConcurrency —— 数据字段，决定卡片长什么样
//
// ─────────────────────────────────────────────────────────────────────
// 三条铁律
// ─────────────────────────────────────────────────────────────────────
//   1. config.models 必须有内容 —— 未登录也要有，否则显示 "0 models"
//   2. authorize() 立刻返回 —— 真正等登录的是 callback()
//   3. refresh 返回的是合并 —— 只给新字段，别把 org / repo 清空
//
// ─────────────────────────────────────────────────────────────────────
// 这个供应商的三条硬事实（读完再改代码）
// ─────────────────────────────────────────────────────────────────────
//   · PAT 调不了模型：api.cnb.cool 的 AI 路径一律
//     403 {"errcode":403,"errmsg":"[NO_RIGHT]OpenAPI only allowed in pipeline"}
//   · 跑模型只有两条路：CNBSESSION（网页登录态，不支持 tools）或自建 relay（支持 tools）
//   · 所有请求必须带 User-Agent，否则 Cloudflare 回 403 Error 1010
//
// ─────────────────────────────────────────────────────────────────────
// 为什么有两条「浏览器」登录
// ─────────────────────────────────────────────────────────────────────
//   设备码（方式一）只拿得到 PAT：额度能查，模型打不了。
//   网页登录（方式三）开一个受控浏览器窗口，同时收下 CNBSESSION（跑模型）与 PAT（查额度），
//   建组织要的也是网页登录态，但默认不建（一个根组织一年只能建 1 个），要建就显式开 createOrg。
//   它要多一个窗口、多一次「确认授权」，所以没有替换掉设备码。

import {
  BASE,
  ICON,
  MODEL_SPECS,
  PLUGIN_VERSION,
  PROVIDER,
  PROVIDER_NAME,
  REFRESH_LEAD_MS,
  SDK,
  USER_AGENT,
  staticModels,
} from "./src/context.mjs"
import { createRefreshLock } from "./src/refresh-lock.mjs"
import { createUsageCache } from "./src/usage-cache.mjs"
import { normaliseOptions } from "./src/options.mjs"
import { loginViaDevice, refreshAccessToken } from "./src/device.mjs"
import { CODES } from "./src/http.mjs"
import { loginViaBrowser } from "./src/web-login.mjs"
import { orgHint } from "./src/org.mjs"
import { fetchTopGroups, fetchUser, listRepos } from "./src/api.mjs"
import {
  accountNameOf,
  displayNameOf,
  ensureCredential,
  pickRepo,
  rawCredentialOf,
  resolveAccount,
  uidOf,
} from "./src/credential.mjs"
import { readLocalCnbToken } from "./src/local-token.mjs"
import { buildLoaderResult, pickTransport } from "./src/chat.mjs"
import { buildModels, keepUnknownModels } from "./src/models.mjs"
import { buildUsage, fetchAccountSnapshot } from "./src/usage.mjs"
import { planOf } from "./src/badges.mjs"
import { doCheckin } from "./src/checkin.mjs"
import { ROUTES } from "./src/context.mjs"

/**
 * 用本机 cnb-cli 的登录态登录。
 *
 * ⚠ 这条路只能读到 `~/.cnb/token` 里的**那一个**账号 —— 在浏览器里换账号不会更新它。
 *   所以想加第二个账号必须用「浏览器授权登录」。
 *
 * 令牌过期就地续期一次（不写回文件：插件不碰用户的 CLI 凭证）。
 */
async function authorizeFromLocal(options) {
  const local = readLocalCnbToken()
  if (!local?.token && !local?.refresh) {
    return {
      type: "failed",
      error: "本机没找到 CNB 凭证。要加账号建议用「浏览器授权登录」；也可以装一下 CLI：npm i -g @cnbcool/cnb-cli && cnb login",
    }
  }

  let access = local.token
  let refresh = local.refresh
  let expires = local.expires

  if (refresh && expires && expires - Date.now() < REFRESH_LEAD_MS) {
    try {
      const renewed = await refreshAccessToken({ refresh, clientId: local.clientId })
      if (renewed) {
        access = renewed.access
        refresh = renewed.refresh
        expires = renewed.expires
      }
    } catch {
      /* 续期失败就用手上的过期令牌试一次，让错误来自 /user 而不是这里 */
    }
  }

  let user = null
  try {
    user = await fetchUser(access)
  } catch (error) {
    return { type: "failed", error: `本机凭证不可用：${error?.message || error}。重新 \`cnb login\` 一次，或改用「浏览器授权登录」。` }
  }
  if (!user) {
    return { type: "failed", error: "本机凭证读不到账号信息（/user 返回空），重新 `cnb login` 一次。" }
  }

  const groups = await fetchTopGroups(access)
  const org = String(options.org || groups[0]?.path || "").replace(/^\/+|\/+$/g, "")
  const repos = org ? await listRepos(access, org) : []
  const repo = pickRepo(repos, "", { ...options, org })

  return {
    type: "success",
    access,
    refresh,
    expires: expires || Date.now() + 8 * 3600_000,
    // 名字取昵称（`cnb.xxxx` 那种自动用户名不是名字，见 credential.mjs 的 displayNameOf）
    accountId: displayNameOf(user),
    uid: String(user.id || user.username || ""),
    org,
    repo,
    metadata: {
      org,
      repo,
      username: user.username || "",
      nickname: displayNameOf(user),
      userId: String(user.id || ""),
      kind: "pat",
      clientId: local.clientId,
      groups: groups.map((g) => g.path),
      loginMethod: "local",
      source: local.source,
    },
  }
}

export const CnbAuthPlugin = async (_ctx, rawOptions) => {
  const options = normaliseOptions(rawOptions)

  // 同一个 refresh_token 的并发续期合并成一次，成功后 60 秒内回放结果。
  // 键必须是凭据身份（refresh_token），不能用 provider id —— 同渠道多账号会串结果。
  const refreshLock = createRefreshLock({ replayMs: 60_000 })

  // 额度卡片会被频繁刷新：成功 60 秒、失败 5 秒，同 key 并发合并。
  const usageCache = createUsageCache({ ttlMs: 60_000, failTtlMs: 5_000 })

  return {
    // ═══ ① 声明 provider ══════════════════════════════════════════════
    config: async (cfg) => {
      cfg.provider ??= {}
      // ⚠ 用 ??= ，不要覆盖用户在 plugins.json 里配的
      cfg.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: SDK,
        api: BASE,
        models: staticModels(), // ⚠ 未登录时也必须有内容（铁律 1）
      }
    },

    auth: {
      provider: PROVIDER,

      // ⚠ 图标要写两份，缺一份就有地方显示灰方块：
      //   这里 auth.icon → 供应商列表那一行、用量概览的卡
      //   package.json 的 magpie.icon → 插件列表那一行、插件详情页左上角
      icon: ICON,
      maxConcurrency: 4,
      refreshLead: REFRESH_LEAD_MS,

      // ═══ ② 登录：四条路 ═══════════════════════════════════════════
      methods: [
        // ── 方式一：浏览器授权（OAuth Device Flow）—— 想加多个账号就走这条 ──
        {
          type: "oauth",
          label: "浏览器授权登录（可加多个账号）",
          async authorize() {
            // ⚠ 立刻返回（铁律 2）：只申请一次设备码，轮询在 callback 里
            return loginViaDevice(options)
          },
        },

        // ── 方式二：读本机 cnb-cli 的登录态 —— 只能读到那一个账号 ──
        {
          type: "oauth",
          label: "用本机 cnb-cli 的凭证（跳过浏览器）",
          async authorize() {
            const local = readLocalCnbToken()
            return {
              url: ROUTES.token,
              instructions: local?.token
                ? "已在本机找到 CNB 凭证，正在校验（过期会自动续期）…"
                : "本机没找到 CNB 凭证。要加账号建议用上面那个「浏览器授权登录」；也可以装一下 CLI：npm i -g @cnbcool/cnb-cli && cnb login",
              method: "auto",
              opened: false,
              async callback() {
                try {
                  return await authorizeFromLocal(options)
                } catch (error) {
                  return { type: "failed", error: String(error?.message || error).slice(0, 400) }
                }
              },
            }
          },
        },

        // ── 方式三：浏览器网页登录 —— 一次拿到「额度」+「通道」──
        //
        // 为什么要多这一条：上面两条拿到的都是 PAT（额度能查、模型打不了）。这条会开一个
        // **受控浏览器窗口**（一次性 profile，不碰用户日常浏览器），用户在里面登录 cnb.cool
        // 再点一次「确认授权」，插件就同时收下 CNBSESSION（跑模型）与访问令牌（查额度）。
        // 建组织要的也正是网页登录态（PAT 申请不到 `group-manage:rw`，实测 invalid_scope），
        // 但**默认不建**：一个根组织一年只能建 1 个、删掉不退还（实测 429），
        // 替用户烧掉一整年的名额不是插件该做的决定 —— 要建就显式 `createOrg: true`。
        //
        // ⚠ `authorize()` 必须**立刻返回**（铁律 2）：设备码、开窗、等用户全在 callback 里。
        //   这里只是报一个「马上要做什么」，不能有任何 await。
        // ⚠ `opened: true`：窗口是插件自己开的，再让宿主开一次用户会看到两个窗口（HOOKS 陷阱 3）。
        // ⚠ URL 那一栏是给宿主/CLI 显示的兜底值，真正的确认页要等 callback 里领到设备码之后
        //   才拼得出来（带 user_code），所以这里只放固定的确认入口。
        {
          type: "oauth",
          label: "浏览器网页登录（一次拿到额度 + 通道）",
          async authorize() {
            return {
              url: ROUTES.deviceVerify,
              instructions:
                "插件会自己开一个受控浏览器窗口：先在窗口里登录 cnb.cool，再点页面上的「确认授权」，" +
                "然后**别关窗口**，等它自己收工。这样一次就能同时拿到网页登录态（跑模型）与访问令牌（查额度）。" +
                "没有组织也不影响跑模型（AI 端点用公开仓库就行）；想自动建组织要在插件选项里写 createOrg: true。",
              method: "auto",
              opened: true,
              async callback() {
                try {
                  return await loginViaBrowser(options)
                } catch (error) {
                  return { type: "failed", error: String(error?.message || error).slice(0, 400) }
                }
              },
            }
          },
        },

        // ── 方式四：粘贴凭证（PAT 或 CNBSESSION，运行时自己认）──
        //
        // ⚠ 这里**绝对不能**加 authorize，也不要加 prompts：
        //   magpie 的 apiKey() 只把 prompts 的答案作为 inputs 传给 authorize
        //   （宿主内部是 `m.authorize(inputs ?? {})`），用户在 key 输入框里填的值
        //   根本不会进到插件里。没有 authorize 时 magpie 直接存 `{ type: "api", key }`，
        //   「这是 PAT 还是 CNBSESSION」交给 src/credential.mjs 在运行时识别并缓存。
        {
          type: "api",
          label: "粘贴访问令牌（PAT 或浏览器 CNBSESSION 都行）",
          placeholder: "CNB 访问令牌（cnb.cool/profile/token 生成）或浏览器里的 CNBSESSION 值",
        },
      ],

      // ═══ ③ 续期 ═══════════════════════════════════════════════════
      //
      // 返回值 **合并** 到旧账号上（不是整体替换）—— 所以只给会变的那三个字段，
      // 别把 org / repo / metadata 一起返回，也别返回空串覆盖它们。
      async refresh(auth) {
        if (!auth?.refresh) return undefined // 粘贴型凭据没有 refresh_token，不续期

        const key = `${PROVIDER}\n${auth.refresh}`
        try {
          const next = await refreshLock.run(key, () => refreshAccessToken({ refresh: auth.refresh }))
          if (!next) return undefined
          return { access: next.access, refresh: next.refresh, expires: next.expires }
        } catch (error) {
          // refresh_token 被拒 → 标记账号，不再重试直到重新登录
          if (error?.signIn === "expired" || /invalid_grant|expired|invalid/i.test(String(error?.message))) {
            throw Object.assign(new Error("CNB 登录已失效，请重新登录"), { signIn: "expired" })
          }
          throw error
        }
      },

      // ═══ ④ 请求接管 ═══════════════════════════════════════════════
      async loader(getAuth) {
        return buildLoaderResult({ getAuth, options })
      },

      // ═══ ⑤ 额度 ═══════════════════════════════════════════════════
      async usage(getAuth) {
        const auth = await getAuth()
        if (!auth || !rawCredentialOf(auth)) return { error: "未登录 CNB：点「浏览器授权登录」，或粘贴凭证", windows: [] }

        // 只缓存有凭据身份的账号；匿名调用本来就不会打到上游。
        const key = String(uidOf(auth) || rawCredentialOf(auth))
        if (!key) return { error: "未登录", windows: [] }

        let snapshot
        try {
          snapshot = await usageCache.read(key, async () => {
            const record = await ensureCredential(auth, { options })
            return fetchAccountSnapshot({ token: record.token || "", org: record.org || options.org })
          })
        } catch (error) {
          // 上游失败 → 让卡片显示原因。抛出去 magpie 只会记成「读取失败」，用户看不到原因。
          //
          // ⚠ 「没有组织 + 这条账号有网页登录态」这一种要换成**带路**的提示：
          //   额度接口只会回「还没有组织」或「额度需要访问令牌」，而这两件事都能被
          //   「浏览器网页登录」一次解决（它同时收 CNBSESSION 与 PAT）。
          //   ⚠ 读钩子里绝不自动建组织 —— 那是对外可见的动作，只允许在用户亲手点的
          //   登录路里做一次（见 src/org.mjs 文件头）。
          //
          //   只在「确实缺凭据 / 缺组织」这两种错误上替换文案：网络抖了、上游 5xx 也换掉的话，
          //   用户会拿着一个组织提示去查一个根本不存在的组织问题。
          const credentialish = error?.code === CODES.signInRequired || error?.code === CODES.invalidRequest
          const hint = credentialish ? orgHint(resolveAccount(auth, options), auth) : ""
          return { error: hint || String(error?.message ?? error), windows: [], ...(error?.signIn ? { signIn: error.signIn } : {}) }
        }

        const account = resolveAccount(auth, options)
        const transport = pickTransport(account, options)
        try {
          return buildUsage({
            credit: snapshot.credit,
            badges: snapshot.badges,
            transport,
            hasSession: Boolean(account.session),
            // 名字：昵称优先（`cnb.xxxx` 自动用户名不是名字，见 credential.mjs 的 displayNameOf）
            username: accountNameOf(
              snapshot.user ? { nickname: displayNameOf(snapshot.user), username: snapshot.user.username } : null,
              auth,
            ),
            org: account.org,
          })
        } catch (error) {
          // 窗口构造器抛的是**编码错误**（比如漏了 used）—— 直接抛出去，用户只会看到
          // 「读取失败」而日志里什么都没有。把它变成有原因的一行文字。
          return { error: `额度窗口拼装失败：${error?.message ?? error}`, windows: [] }
        }
      },

      // ═══ ⑥ 签到 ═══════════════════════════════════════════════════
      //
      // CNB 没有每日签到：免费 AI Credit 按月发放。默认返回 inactive；
      // 配了 claim.url 才会去打用户自己的领取端点。
      async checkin(getAuth) {
        const auth = await getAuth()
        if (!auth || !rawCredentialOf(auth)) return { outcome: "failed", message: "未登录 CNB" }
        try {
          const record = await ensureCredential(auth, { options })
          const account = resolveAccount(auth, options)
          return await doCheckin({
            options,
            token: record.token || "",
            org: account.org || options.org,
            repo: account.repo || options.repo,
          })
        } catch (error) {
          return { outcome: "failed", message: String(error?.message ?? error) }
        }
      },
    },

    // ═══ ⑦ 每账号的模型目录 ═══════════════════════════════════════
    provider: {
      id: PROVIDER,

      async models(provider, { auth } = {}) {
        // CNB 没有 /models 端点，所以这里不「拉目录」，只按通道把能力标对。
        let transport = "none"
        if (auth && rawCredentialOf(auth)) {
          const account = resolveAccount(auth, options)
          transport = pickTransport(account, options)
          // 只粘了 CNBSESSION 时档案里没有仓库路径，补一次探测（失败不影响列模型）
          if (!account.repo || !account.session) {
            try {
              await ensureCredential(auth, { options })
              transport = pickTransport(resolveAccount(auth, options), options)
            } catch {
              /* ignore */
            }
          }
        }
        return keepUnknownModels(provider, buildModels(provider, { transport }))
      },
    },

    // ═══ ⑧ 每请求加头 ═════════════════════════════════════════════
    "chat.headers": async (input, output) => {
      const id = input?.model?.providerID ?? input?.provider?.info?.id
      if (id !== PROVIDER) return
      output.headers["x-cnb-client"] = USER_AGENT
    },
  }
}

// 供测试引用（⚠ 入口文件不要导出 helper 函数，否则会被 magpie 当插件调用）
export const _internal = {
  PROVIDER,
  PROVIDER_NAME,
  BASE,
  PLUGIN_VERSION,
  MODEL_SPECS,
  staticModels,
}
