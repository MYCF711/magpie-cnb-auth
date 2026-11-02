// examples/split/index.mjs —— 装配用的入口：**只有装配，没有实现**
//
// 这是「插件长大后」的形态：根 `index.mjs` 从 535 行缩到 40 行，
// 每一项钩子在自己的文件里。四个真实插件的 `index.mjs` / `src/` 行数对比见
// 根目录 AGENTS.md 的「五、长大之后」。
//
// 这里只演示三种典型形态（纯声明 / 异步取数 / 纯计算），其余五个钩子照同一规则搬：
//
//   config.mjs   ← 纯声明          （同类的还有 headers.mjs）
//   models.mjs   ← 异步取数 + 降级 （同类的还有 loader.mjs）
//   usage.mjs    ← 纯计算 + 归一化 （同类的还有 checkin.mjs）
//   methods.mjs  ← 登录流程（有状态、最长的一个）
//   refresh.mjs  ← 续期（必须串行）
//
// 搬的时候只改一处：把闭包里的外部变量收进 `c`。这样每个 hook 都是
// `makeXxx(c) → 钩子函数`，测试时换个 `c` 就能脱离宿主跑。

import { PROVIDER, PROVIDER_NAME, BASE, SDK, ICON, REFRESH_LEAD_MS, staticModels } from "../../src/context.mjs"
import { makeConfig } from "./src/hooks/config.mjs"
import { makeModels } from "./src/hooks/models.mjs"
import { makeUsage } from "./src/hooks/usage.mjs"

/**
 * `c` 就是「这个插件知道的一切」。一次构造，传给每个工厂。
 *
 * 把三个上游调用也挂在这里（而不是让 hook 自己 import `../api.mjs`）的好处：
 * 测试里把它们换成假的，就能脱离网络跑完所有钩子。
 */
const c = {
  PROVIDER,
  PROVIDER_NAME,
  BASE,
  SDK,
  ICON,
  staticModels,

  // TODO：这三条是仓库根 index.mjs 里那五个 TODO 的一部分，搬过来即可
  async fetchLiveModels(_auth) {
    throw new Error("TODO: 拉这个账号能用的模型列表")
  },
  async fetchPoints(_auth) {
    return {} // 没有计费接口就返回空表：buildModels 会当成「接口失败」不过滤
  },
  async fetchUsage(_auth) {
    throw new Error("TODO: 拉额度")
  },
}

export const XxxAuthPlugin = async (_ctx, _options) => {
  return {
    config: makeConfig(c),

    auth: {
      provider: c.PROVIDER,
      icon: c.ICON, // ⚠ 图标要写两份，另一份是 package.json 的 magpie.icon
      maxConcurrency: 4,
      refreshLead: REFRESH_LEAD_MS,

      usage: makeUsage(c),

      // 其余五个钩子按 README 里的规则搬进来：
      // methods: makeMethods(c),
      // refresh: makeRefresh(c),
      // loader: makeLoader(c),
      // checkin: makeCheckin(c),
    },

    provider: {
      id: c.PROVIDER,
      models: makeModels(c),
    },

    // chat: { headers: makeHeaders(c) },
  }
}
