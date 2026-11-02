// src/options.mjs —— 插件选项的归一化
//
// 选项来自 `~/.config/magpie/plugins.json` 里这一项的 `options`，用户可能：
//   · 什么都不填          → 全部自动探测
//   · 只填 org / repo     → 覆盖探测结果
//   · 填个 relay          → 换通道（这条通道支持 tools）
//   · 填个 claim.url      → 接上自己的「领积分」端点
//
// ⚠ 这里必须**容忍一切输入**：magpie 里那个选项编辑器能把数字存成字符串、
//   把 `relay` 存成 `""`、把布尔存成 `"false"`。任何一处 `undefined.xxx` 都会变成
//   「插件加载失败」，而用户看不出是自己填错了。

/** 字符串字段，去空白、去首尾斜杠。 */
function text(value, fallback = "") {
  if (value === null || value === undefined) return fallback
  return String(value).trim()
}

/** 仓库路径：去掉首尾斜杠，多余的段不管（交给上游判）。 */
function path(value) {
  return text(value).replace(/^\/+|\/+$/g, "")
}

/** HTTP 方法只留常见几个，别的按 GET 处理 —— 别让用户填个 `post ` 就 405。 */
function method(value) {
  const m = text(value, "POST").toUpperCase()
  return ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(m) ? m : "POST"
}

/** 通道只认三个值；`auto` 是默认。 */
function transport(value) {
  const t = text(value, "auto").toLowerCase()
  return ["auto", "relay", "cookie"].includes(t) ? t : "auto"
}

/** 归一化整份选项。返回值一定可以做 `.org` / `.relay.url` 这样的读取。 */
export function normaliseOptions(raw) {
  const src = raw && typeof raw === "object" ? raw : {}
  const relay = src.relay && typeof src.relay === "object" ? src.relay : {}
  const claim = src.claim && typeof src.claim === "object" ? src.claim : {}

  return {
    org: path(src.org),
    repo: path(src.repo || src.repoPath),
    transport: transport(src.transport),
    relay: { url: text(relay.url), key: text(relay.key) },
    claim: {
      url: text(claim.url),
      method: method(claim.method),
      body: typeof claim.body === "string" && claim.body.trim() ? claim.body : "{}",
    },
    // 探测不到仓库时用来猜路径。默认 `code` —— 与 CNB 新建仓库的默认名一致。
    repoName: path(src.repoName) || "code",
    // ⚠ 建组织**默认关**：一个根组织一年只能建 1 个，删掉还不退还
    //   （真机实测 2026-11-03，`429 The root organization has reached its yearly creation limit`）。
    //   一次登录替用户烧掉一整年的名额，不是插件该替他做的决定 —— 要自动建就显式写 true。
    createOrg: src.createOrg === true,
  }
}

/** 有没有配 relay —— 决定「能不能用 tools」。 */
export function hasRelay(options) {
  return Boolean(options?.relay?.url)
}
