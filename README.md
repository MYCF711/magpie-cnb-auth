# 云原生构建 CNB · magpie 供应商插件

把一个 **CNB（cnb.cool）** 账号变成 magpie 里的一个供应商：浏览器点一次登录，
当月 AI Credit 与认证徽章直接上卡片；再把浏览器里的 **CNBSESSION** 粘进来
（或者指向你自己的中继），DeepSeek / GLM / Kimi 就能在 agent 里跑。

```
配额      每月 AI Credit（每月 1 日 UTC 重置，具体数值以你组织里为准）
可选模型  8 个（DeepSeek V4.1 / GLM 5.3 / Kimi K3 / Hunyuan 4 等）
登录方式  3 种（浏览器设备码 / 本机 cnb-cli / 粘贴凭证）
跑模型要  一条 CNBSESSION（网页登录态）或一条自建 relay —— 见下面「两步走」
```

> ⚠ **登录 ≠ 能聊天。** 设备码登录、读本机 `cnb-cli`、粘贴访问令牌，这三条路拿到的都是
> **访问令牌（PAT）**，而 CNB 的 AI 端点只吃网页登录态：拿 PAT 去打上游一律回
> `403 [NO_RIGHT] OpenAPI only allowed in pipeline`。
> 所以额度条会立刻有数，但「AI 通道」那一行会明确写着还差什么。

---

## 两步走

1. **登录**（三种方式任选）→ 拿到访问令牌：额度、徽章、账号名全都出来了。
2. **补一条通道**（任选其一）→ 才能真跑模型：
   - **粘 CNBSESSION**：浏览器登录 cnb.cool → F12 → Application → Cookies →
     复制 `CNBSESSION` 的值 → 在「粘贴访问令牌」那一栏粘进去（插件会在运行时认出这是会话而不是令牌）。
   - **配 relay**：选项里 `transport: "relay"` + `relay.url` 指向一个 OpenAI 兼容中继。
     **要工具调用只能走这条** —— CNB 网页端点结构性拒绝 tools。

## 功能

- **一键登录，可以加多个账号**：走 CNB 自己的 OAuth 设备码授权，浏览器里确认一次就行；
  全程不读也不写你本机的任何凭证文件，所以登几个账号都不会互相覆盖。
- **不想点浏览器也行**：装过 `cnb-cli` 的话，直接读它的登录态（过期自动续期）；
  手头已经有访问令牌或浏览器 Cookie 的话，粘一个进去也认。
- **当月 Credit 直接上卡片**：已用 / 总额 / 特权额度 / 重置时间一次显示，
  读数拿不到时明确说原因 —— 不伪造 0%，也不拿 `0 / 0` 冒充「已用光」。
- **认证徽章**：天才程序员、高校学生 / 老师 / 校友 / 职工、内测玩家 / 开服玩家、TDP，
  从账号自己的 `identity_providers` 读，读不到时用特权额度说明兜底。
- **两条 AI 通道**：CNBSESSION 直连 CNB 网页端点（不用 API key），或指向你自己的
  OpenAI 兼容中继（**要工具调用走这条**）。
- **诚实的工具能力标注**：Cookie 通道下模型会标成不能调工具 —— 因为上游确实会拒，
  与其让 agent 发出去吃一个 403，不如提前说清。
- **令牌自动续期，且是串行的**：同一个 `refresh_token` 不会并发换两次
  （换两次 = 账号被踢下线，这是这类插件最常见的坑）。

## 模型

CNB 的可选模型是固定的 8 个（它没有公开的 `/models` 端点）：

| 模型 | 上下文 | 最大输出 | 说明 |
|---|---|---|---|
| `deepseek-v4.1-flash` | 1M | 64K | 默认 |
| `deepseek-v4-flash` | 1M | 64K | |
| `glm-5.3` | 1M | 64K | 带思考档 |
| `glm-5.3-flash` | 1M | 128K | 带思考档 |
| `glm-5.3-flash-vision` | 1M | 32K | **能收图** |
| `glm-5.2` | 200K | 32K | |
| `kimi-k3` | 1M | 32K | 带思考档 |
| `hy4-preview` | 1M | 64K | 带思考档 |

在 magpie 里它们显示成 `cnb/deepseek-v4.1-flash` 这样的名字。

## 签到

CNB **没有**「每日签到」接口 —— 免费 AI Credit 是按月发的（每月 1 日 UTC 重置），
所以这个插件的签到结果是 `inactive`（不假装签了）。

如果你的领取流程是自建的（比如某个包装端点），在插件选项里填 `claim.url`，签到就会去打它。

## 安装

在 magpie 里：**插件 → 添加插件 → 填仓库地址**。

```bash
magpie plugin add github:MYCF711/magpie-cnb-auth
magpie plugin login cnb      # 选「浏览器授权登录」
magpie quota                 # 看当月 Credit 与徽章
magpie provider test cnb     # 发一个很小的请求验证通道
```

装完在应用的 **供应商** 页能看到 `云原生构建 CNB` 这一行，登录后卡片上就有额度和徽章。

### 选项（可选，全部有默认值）

```json
{
  "org": "",              // 组织 slug，留空自动探测
  "repo": "",             // 仓库路径（AI 通道要用），留空自动取第一个可见仓库
  "transport": "auto",    // auto | cookie | relay
  "relay": { "url": "", "key": "" },
  "claim": { "url": "", "method": "POST", "body": "{}" },
  "repoName": "code"
}
```

多数人不需要填任何一项：登录时会自动探测组织与仓库。

## 常见问题

**1. 为什么点完登录，模型能聊了但额度条是空的？**
额度查的是 `api.cnb.cool`，它只认**访问令牌**；如果你是用「粘贴 CNBSESSION」登录的，
那条凭据跑不了模型以外的接口。到 <https://cnb.cool/profile/token> 生成一个访问令牌补进来即可。

**2. 为什么模型调不了工具？**
CNB 的网页 AI 端点结构性拒绝工具调用（上游回 `403 Agent calls are not allowed`）。
要工具就把 `transport` 设成 `relay`，指向一个 OpenAI 兼容的中继；Cookie 通道本身做不到。

**3. 报「缺少仓库路径」怎么办？**
CNB 的 AI 端点挂在 `/{org}/{repo}/-/ai/chat/completions` 下，必须有仓库。
登录时会自动取你组织下第一个可见仓库；取不到就在选项里手填 `org` 与 `repo`。

**4. 报「上游返回了 HTML」是什么意思？**
通常是仓库路径不对（那个路径不存在），或者登录态过期了。它**不是**模型坏了 ——
所以插件没有把它报成「模型不存在」，否则 magpie 会把这条模型搁置。

**5. 想加第二个账号？**
用「浏览器授权登录」，可以登任意多个。「用本机 cnb-cli 的凭证」只能读到那一个账号 ——
`~/.cnb/token` 只由终端的 `cnb login` 写，在浏览器里换账号不会更新它。

**6. `deepseek-v4.1-flash` 之外的模型好像都答得差不多？**
有作者观察到 CNB 上游对部分模型 id 会静默回退到主模型。这是服务端行为，
插件不做别名改写（`model` 原样透传）—— 硬写一张映射表只会让你以为切了模型。

**7. 卡片说「这个 CNB 账号还没有组织」？**
CNB 的 AI Credit 按**组织**发放，AI 端点也挂在 `/{org}/{repo}/-/ai/...` 下，
所以刚注册、还没建组织的账号既没有额度可读、也没有通道可用（实测：这种账号的
`/user/groups` 就是空数组）。到 <https://cnb.cool/new/groups> 建一个组织（或让管理员把你加进去），
再回来刷新这张卡就行。已经有组织却还显示这条，就在插件选项里直接填 `org`。

**8. 卡片上的账号名是我填的昵称吗？**
是。CNB 给新账号自动生成的 `username` 长得像 `cnb.dI2DzHg0QHA`，那不是名字 ——
插件取的是 `nickname`；昵称也取不到时**留空**，由 magpie 回退成供应商名，而不是显示一串 ID。

## 参考源

| 来源 | 用了什么 |
|---|---|
| [`411304344/opencode-cnb-account`](https://github.com/411304344/opencode-cnb-account)（MIT） | CNB 的设备码授权参数、双域名鉴权分工、AI 端点的 header 与「只吃流式」、额度三个接口的字段名、徽章判定字典、Cloudflare 的 UA 要求 —— 全部协议结论来自这份参考实现的实测记录 |
| [`MYCF711/magpie-plugin-scaffold`](https://github.com/MYCF711/magpie-plugin-scaffold)（MIT） | 仓库结构、九钩子装配方式、`src/quota.mjs` / `refresh-lock.mjs` / `usage-cache.mjs` / `openai-sse.mjs`、检查与打分脚本 |
| [magpie 插件文档](https://usemagpie.ai/docs/zh/plugins) | 钩子契约本身 |

实现细节、协议取证与「为什么这么写」在 [docs/internals.md](./docs/internals.md)。

## 许可

MIT。见 [LICENSE](./LICENSE) 与 [NOTICE.md](./NOTICE.md)。
本项目与 CNB（cnb.cool）官方无关，是社区插件。

> 更新记录：[CHANGELOG.md](./CHANGELOG.md)
