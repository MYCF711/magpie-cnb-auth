# 拆分示例：`index.mjs` 只装配

根目录那个 `index.mjs` 是**单文件入门**形态：九个钩子一屏读完，五个 TODO 在底部。
那是给「第一次写插件」用的。但它会长 —— 四个真实插件的实测：

| 仓库 | `index.mjs` | `src/` |
|---|---|---|
| 模板（根目录那份） | 535 行 | 1 文件 / 78 行 |
| `magpie-magicrew-auth` | **80** | 21 文件 / 3,683 行 |
| `magpie-officeace` | 347 | 7 文件 / 1,397 行 |
| `magpie-loomy-auth` | 611 | 9 文件 / 1,905 行 |
| `magpie-today` | 715 | 18 文件 / 2,812 行 |

这个目录演示**长大之后**的样子：`index.mjs` 只剩装配，每一项钩子在自己的文件里。

## 这里有什么

```
index.mjs                     ← 只有装配 + 一个 c 对象（40 行）
src/hooks/
  config.mjs                  ← ① 纯声明
  models.mjs                  ← ⑦ 异步取数 + 三态降级
  usage.mjs                   ← ⑤ 纯计算 + 归一化
```

**只演示三个**，因为钩子只有三种形态，其余五个照同一规则搬：

| 形态 | 特征 | 这里的例子 | 还有谁 |
|---|---|---|---|
| 纯声明 | 不网络、不算数，只交形状 | `config.mjs` | `chat.headers` |
| 异步取数 | 要网络，每个 return 都在决定「出错时界面长什么样」 | `models.mjs` | `auth.loader` |
| 纯计算 | 把拿到的数字摆成契约要的字段 | `usage.mjs` | `auth.checkin` |
| 有状态 + 最长 | 登录流程、要串行 | —— | `auth.methods` / `auth.refresh` |

## 怎么搬

1. 在根 `index.mjs` 里找到 `// ═══ ① 声明 provider ═══` 这种分节标记，一共 8 处
2. 每处整段复制到一个 `src/hooks/<名字>.mjs`，外面包一层工厂：

   ```js
   export function makeXxx(c) {
     return async (...args) => { /* 原来的实现，把 PROVIDER/BASE 换成 c.PROVIDER/c.BASE */ }
   }
   ```

3. **把闭包里的外部变量收进 `c`** —— 这是唯一需要动脑的地方。
   实际用到的是：常量（`c.PROVIDER` 等）、上游调用（`c.fetchXxx`）、store（直接 import 就行）。
4. 根 `index.mjs` 改成这里的形状：`config: makeConfig(c)`、`auth: { … }`、`provider: { … }`
5. 跑一遍：`node scripts/check.mjs` + `node --test`

## 为什么值得拆

- **测试**：每个 hook 都能脱离宿主跑（换掉 `c.fetchXxx` 即可），`tests/semantics.test.mjs` 锁的正是这些
- **改一处只读一个文件**：`models` 出问题就去 `src/hooks/models.mjs`，不用在 500 行里翻
- **多站点**：`makePlugin(SITE)` 只要换个 `c` 就多一个站点，见 [MULTI-PROVIDER.md](../../MULTI-PROVIDER.md)

## 验收

```bash
node -e "import('./examples/split/index.mjs').then(m=>console.log(Object.keys(m.XxxAuthPlugin ? {} : {})))"
node scripts/check.mjs      # 根目录跑，检查的是根 index.mjs
node --test                 # 语义测试
```

⚠ 这个目录只是**形态示范**，没有实现真实厂商逻辑（`c.fetchXxx` 全是 TODO）。
需要一份完整可跑的，看四个真实插件里任意一个的 `src/`。
