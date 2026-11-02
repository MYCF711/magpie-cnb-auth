# 共创说明

> 这个仓库不是「另一个 magpie 插件模板」，是**官方指导文件的一份衍生说明书**。
> 官方负责规则，我们负责「规则写错之后会发生什么」和「怎么一条命令验出来」。
> 所以它天然是共创的 —— 官方改一条，这里就该跟一条；社区踩一个坑，这里就该收一条。

---

## 一、这个仓库的定位（先对齐，再动手）

| | 官方 | 本仓库 |
|---|---|---|
| 载体 | `usemagpie.ai/docs/plugins` + `yetone/magpie` 的 `docs/subsystems/provider-plugins.md` | 这个仓库的 GUIDE / HOOKS / SCORING |
| 讲什么 | **规则**：钩子叫什么、返回值什么意思、什么时候调 | **后果**：少写一个字段会怎样、写错一个值会怎样、怎么验 |
| 谁维护 | yetone | 任何人（见下） |
| 许可 | MIT, Copyright (c) 2026 yetone | MIT，引用部分保留原归属 |

**我们不声称「比官方全」。** 2026-10-26 那条 `auth.checkin` 的缺口被补上之后（[issue #392](https://github.com/magpie-community/plugins/issues/392) → magpie v0.1.1582），
任何「官方漏了 X」的说法都必须**当场给出 grep 证据**，否则就是过期陈述。见 [OFFICIAL-SOURCES.md](./OFFICIAL-SOURCES.md) 第二节。

---

## 二、三条纪律（贡献前必须遵守）

1. **每条结论必须能追到官方锚点，或者标「补充」。**
   格式：正文里写结论，[OFFICIAL-SOURCES.md](./OFFICIAL-SOURCES.md) 里加一行映射。
   写不成映射的，不收。

2. **每个「补充」必须带判据。**
   「我觉得应该这样」不收；「跑这条命令，看这个字段，是 A 就是对的」才收。
   判据要能当场执行：一条 `curl`、一个 `node -e`、一个 `grep`。

3. **官方更新，先改索引，再改正文。**
   `node scripts/check-magpie-stable.mjs` 报 `2` 时，先把 [OFFICIAL-SOURCES.md](./OFFICIAL-SOURCES.md)
   的基线日期改掉、把已经从「官方没写」变成「官方写了」的条目删掉，再动正文。
   顺序反了，索引就会变成假的。

---

## 三、可以贡献什么

| 类型 | 改哪份文件 | 要跑什么 |
|---|---|---|
| 发现官方文档某条规则「没写后果」 | [OFFICIAL-SOURCES.md](./OFFICIAL-SOURCES.md) 第二节 + 对应正文 | `node scripts/check.mjs` |
| 踩到一个「不报错但行为不对」的坑 | [AGENTS.md](./AGENTS.md) 第二节（症状 → 判据 → 出处） | 给出复现命令 |
| 发现某个字段的写法会丢数据 | [HOOKS.md](./HOOKS.md) 对应章节 | 附 `curl /v1/magpie/quotas` 或 `trace` 的实测输出 |
| 发现评分卡的某项可以自动算 | [scripts/score.mjs](./scripts/score.mjs) + [SCORING.md](./SCORING.md) | `node scripts/score.mjs` 自测 |
| 发现说明书写错了 / 过时了 | 直接改，并在 [CHANGELOG.md](./CHANGELOG.md) 记一条 | 全套四件：check / test / score / pack |

**不收的**：把官方文档整段复制进来（要引用不超过 3 行 + 链接）；没有判据的「经验之谈」；
和供应商插件无关的内容（middleware / tools / pages 请直接提给官方）。

---

## 四、提交前必须过的四道门

```bash
node scripts/check.mjs        # 规定：失败必须 0
node --test                   # 语义：16 条必须全过
node scripts/score.mjs        # 评分：自动分 ≥45
npm pack --dry-run            # 打包面：README / CHANGELOG / 新文档在不在包里
```

四条都过，再提 PR。任何一条没过就说「改好了」，是无效贡献。

---

## 五、和官方的关系（这一段决定怎么发 issue）

- **不请求官方收编这个仓库。** 官方 [contributors.md](https://github.com/yetone/magpie/blob/main/docs/contributors.md)
  写明 *"PRs are open to collaborators only"*，且对 low-value PR 有明确的 block 政策。
- **正确形态是 issue，内容是缺陷 + 证据。** 先例：[#392](https://github.com/magpie-community/plugins/issues/392)
  （官方文档缺 `auth.checkin`）—— 附二进制契约原文、社区三个包的实际用法、真实状态文件、第三方适配器引用；
  yetone 当天回复并在 v0.1.1582 补齐 en/zh/ja 三语，issue 当天关闭。
- **邀请共创的正确说法**是：「我逐条核了官方 22 个锚点，这 8 条规则官方没写后果（附 grep 证据），
  已整理成可执行判据；请确认哪几条是官方有意不写的。」——**不是**「我做了个脚手架，请看看」。

---

## 六、许可与归属

本仓库以 MIT 发布。引用的官方文档与 `yetone/magpie` 代码片段版权归 **yetone**（MIT, Copyright (c) 2026 yetone）。
引用超过 3 行时，在引用处保留这句归属。详见 [OFFICIAL-SOURCES.md](./OFFICIAL-SOURCES.md) 顶部。
