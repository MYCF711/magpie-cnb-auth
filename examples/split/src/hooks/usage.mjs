// examples/split/src/hooks/usage.mjs —— ⑤ 额度
//
// 这一类钩子是**纯计算 + 归一化**：拿到的数字怎么摆成 magpie 要的那几个字段。
// 它没有网络重试的花样，但**有一条不能错**：每条窗口的 `used` 必须给。

export function makeUsage(c) {
  return async function usage(getAuth /* , provider */) {
    const auth = await getAuth()
    if (!auth) return { error: "未登录", windows: [] }

    try {
      const u = await c.fetchUsage(auth) // 仓库根 index.mjs 里那个 TODO

      return {
        plan: u.plan, // 卡片上的 "Free plan" 标签
        user: u.user, // 厂商那边这个账号的名字
        balance: u.balance, // "$12.40"
        renew: "auto", // "auto" | "off"
        until: u.until, // 套餐到期

        // ⚠⚠ used 必填，而且是数值（0-100，超额可 >100）。
        //   它不只是画进度条 —— magpie 用它排序账号（>=98 归 spent 排到最后），
        //   而 `used: Math.max(0, num(w?.used))` 会把「没上报」当成 0 = 满额。
        //   漏了它，一个耗尽的账号会被顶到路由队首，还显示「剩余 100%」。
        windows: [
          {
            name: "积分",
            used: u.percentUsed,
            display: `${u.used} / ${u.total} 积分`,
            amount: u.used,
            limit: u.total,
            unit: "积分",
            resetsAt: u.resetsAt,
            aside: false,
          },
        ],

        // 三种边角情形，照抄时可以挑着用 —— 共同点是**都要给 used**：
        //
        //   上限拿不到（厂商不下发 total）：
        //     { name: "积分", used: 0, aside: true, display: "1,234 剩余（上限未知）" }
        //
        //   号被蹬空（一点额度都没有）：
        //     // 千万不要「什么都不画」—— 不画 = 没有参与路由的窗口 = 它继续排前面
        //     { name: "积分", used: 100, display: "已耗尽" }
        //
        //   无周期、无上限的池（永久积分 / 赠送额度）：
        //     { name: "永久积分", used: 0, aside: true, display: "5,500" }
      }
    } catch (e) {
      // error 字段会替代 windows 显示。不要静默返回 0 —— 那正是「空号排队首」的成因
      return { error: String(e?.message ?? e), windows: [] }
    }
  }
}
