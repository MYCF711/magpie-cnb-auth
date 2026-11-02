// examples/split/src/hooks/models.mjs —— ⑦ 每账号的模型目录
//
// 这一类钩子最典型：**异步取数 + 三态降级**。同类的还有 `auth.loader`、`auth.usage`。
// 它跟「纯声明」那类的区别是：这里每一处 return 都是在决定「出错时用户的界面长什么样」。

import { buildModels } from "../../../../src/models.mjs"
import { readSnapshot, writeSnapshot } from "../../../../src/store.mjs"

export function makeModels(c) {
  return async (provider, { auth } = {}) => {
    const fallback = c.staticModels()
    if (!auth || auth.type !== "oauth") return fallback

    // ① 上游整个挂了 → 退回上次快照，**不要返回空表**（空表 = 卡片从列表里消失）
    const snapshot = readSnapshot(c.PROVIDER)

    try {
      const live = await c.fetchLiveModels(auth) // 仓库根 index.mjs 里那个 TODO
      if (!live.length) return snapshot?.models ?? fallback

      // ② 计费接口单独一个 try：它挂了只影响「有没有倍率」，不该影响列表本身
      const points = await c.fetchPoints(auth).catch(() => ({}))

      const { models } = buildModels(live, points, (id, name, vision, opts) => ({
        ...(fallback[id] ?? Object.values(fallback)[0] ?? {}),
        id,
        name: name ?? id,
        capabilities: {
          ...((fallback[id] ?? Object.values(fallback)[0])?.capabilities ?? {}),
          attachment: !!vision,
          input: { text: true, image: !!vision },
        },
        ...(opts.free ? { free: true } : {}),
        ...(!opts.free && Number(opts.rate) > 0 ? { rate: Number(opts.rate) } : {}),
      }))

      // 只缓存成功的这一次；空表别覆盖好的快照
      if (Object.keys(models).length) writeSnapshot(c.PROVIDER, models)
      return models
    } catch (e) {
      // ③ 登录真的失效 → 抛给 magpie，它会把这个账号标成要重登
      //    ⚠ 只有「确定失效」才抛。模型级的 4xx 要翻成 404，见 src/api.mjs 的 asModelError
      if (/401|403|unauthorized|expired|登录失败/i.test(String(e?.message ?? e))) {
        throw Object.assign(new Error("登录已失效"), { signIn: "expired" })
      }
      return snapshot?.models ?? fallback
    }
  }
}
