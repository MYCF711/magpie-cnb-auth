# MAINTENANCE.md —— 维护台账（给接手的 agent 看）

> 接手前先读这一页。读完再按 AGENTS.md「一、先定位你在哪一步」去读对应文档。
> **每次干完活必须回来更新「当前状态」与「下一步」。**

---

## 一、身份

| 项 | 值 |
|---|---|
| 仓库 | `magpie-plugin-scaffold` |
| npm 包名 | `magpie-plugin-scaffold` |
| 当前版本 | `0.3.6`（待发布） |
| 定位 | magpie 供应商插件脚手架：模板 + 21 个通用 `src/` 模块 + 28 条坑表 + 评分卡 + 受控发布脚本 |
| 现状负责人 | 待派（候选角色：`plugin-forge`） |

## 二、当前状态（2026-10-31 15:25）

```
分支        feat/magpie-name-and-npm-publish（从 e5b0b12 起）
待发布      0.3.0：slug + magpie.name、npm publish 门禁、browser-login
工作区      本分支未提交（发布前）
```

| 资产 | 数量 |
|---|---|
| `src/` 模块 | 21 个（见 AGENTS.md 第五节表） |
| `tests/` | 18 个 / 161 条（`node --test` 全跑） |
| `HOOKS.md` | 21 章字段级钩子契约 |
| AGENTS.md 坑表 | 28 条 |

## 三、下一步

**P1 · 显示名约定 + 占位符机制已发布（v0.2.0，PR #14 / 1f60788）。**

- 约定：`package.json.name` 与 provider `name` 都是 `<中文> <English>`；英文照抄厂商官方品牌大小写；npm 包名由 `publish:npm` 注入
- 模板默认占位符：`⚠ 未命名插件 Unnamed Plugin` / `⚠ 未命名供应商 Unnamed Provider`；`check.mjs` 严格模式会失败，脚手架自身用 `--template` 放行
- `create.mjs` 强制 `--name`，生成 `scripts/publish-npm.mjs`（`PUBLISH_AS` = npm 包名）；`tests/adoption.test.mjs` 覆盖正/负例
- 测试：`node --test` 157 条全过；`node scripts/check.mjs --template` 退出 0；`npm pack --dry-run` 退出 0

**下一批候选（按原顺序）：**

```
- openai-response   Responses API 形态
- credential        凭据读取的公共层
- device-id         设备身份头
- catalog           模型目录缓存
```

## 四、硬约束

- **禁止直推 `main`**：功能分支 → PR → 必需检查 `rules` 全绿 → 合并 → `node scripts/release.mjs` 从与 `origin/main` 一致的提交发版。
- 发布前必跑：`node scripts/check.mjs`（退出 0）、`node --test`、`node scripts/check-maintenance.mjs`、`npm pack --dry-run`。
- 改 `HOOKS.md` 的结论前先跑 `python extract-contract.py && node scripts/contract-diff.mjs`，按差集判断。
- 判断要不要跟 magpie 升级：只看稳定渠道（`node scripts/check-magpie-stable.mjs`）。

## 五、相关会话棋谱

`kifu/` 下有两份，读 `kifu/README.md` 看导读：

- `kifu/session-6af827bd/` —— 联系 magpie 官方 + 脚手架改造（190 节点）
- `kifu/session-c328440a/` —— 仓库维护方法与受控发布（388 节点）

## 六、给接手者的最短路径

1. 读本文件
2. `git status` + `git log --oneline -5` 核实现状
3. 读 `AGENTS.md` 的定位表 → 按任务读对应文档
4. 干活 → `node scripts/check.mjs` + `node --test` → 更新本文件 → 回报 Lead
