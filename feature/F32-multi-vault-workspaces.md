---
title: F32 · 多 vault / 工作区切换
type: plan
owner: PM
status: proposed
priority: P1
effort: M
round: R7
created: 2026-06-17
tags: [工作区, 多库, 切换]
---

# F32 · 多 vault / 工作区切换

> 一句话:支持**多个命名工作区(vault)**并随手切换,让个人 / 工作 / 不同客户的文档各归各库、互不串扰,而不是只能共用一个 `$DOCKY_VAULT`。

## 背景与痛点

docky 现在**只有一个 vault**:

- vault 路径固定解析为 `$DOCKY_VAULT`,否则 `~/docky-vault`(`src/config.ts`)。
- 想把"个人笔记""公司项目""客户 A / 客户 B"分库隔离,只能不停手改环境变量,极易**写错库、混入彼此**。
- 没有 vault 注册表与切换器:F05 解决的是"一个 vault 内"的上手,跨 vault 切换无解。

## 目标 / 非目标

**目标**
- **工作区注册表**:`docky vault add <名> <路径>` / `docky vault list` / `docky vault use <名>`;TUI `/vault` 选择器。
- 每个工作区**完全隔离**(各自 `projects/`、config、F31 远程)。
- 当前工作区在 CLI/TUI **常驻可见**(状态栏/提示)。
- **向后兼容**:`$DOCKY_VAULT`/默认库作为"default"工作区,老用户零感知。

**非目标**
- 不做跨工作区检索/引用(那是 F15 在单库内的事;跨库默认完全隔离)。
- 不替代 F31(单个工作区内的团队同步)。

## 用户故事

- 作为顾问,我 `docky vault use 客户A` 进客户 A 的库,工作完 `docky vault use 公司` 切回,绝不串档。
- 作为用户,我 TUI 里 `/vault` 一览所有工作区并切换。

## 交互设计

```
$ docky vault list
* default   ~/docky-vault
  公司      ~/work/docky
  客户A     ~/clients/a/docky   (remote: git@…)
$ docky vault use 公司
✓ 当前工作区:公司  (~/work/docky)
```

## 技术落点

- 用户级注册表(如 `~/.docky/workspaces.json`):`{name, path}[]` + `active`。
- `src/config.ts`:`vaultDir()` 改为"活动工作区优先,其次 `$DOCKY_VAULT`/默认",保持兼容。
- `src/cli.ts` / `commands.ts`:`vault add/list/use` 与 `/vault`;TUI chrome 显示当前工作区。

## 验收标准

- [ ] 可注册/列出/切换命名工作区,切换后所有命令作用于该库。
- [ ] 工作区之间完全隔离(projects/config/remote 各自独立)。
- [ ] 当前工作区在 CLI/TUI 可见。
- [ ] `$DOCKY_VAULT`/默认库仍作为 default 工作区可用(向后兼容)。
- [ ] vault 解析与切换有单测。

## 衡量指标

- 注册 >1 个工作区的用户比例。
- 因共用单库导致的"写错库/混档"问题减少。

## 风险与依赖

- 切换需明确反馈当前库,避免误操作到错误工作区。
- 与 F31(每工作区各自远程)、F18(每工作区各自配置)协同;F05 上手在每个新工作区生效。

## 与其他提案的关系(迭代递进)

- 把 docky 从"单库"升级为"**多工作区**",是团队/多客户场景的前置。
- 与 **F15** 互补(库内跨项目授权 vs 库间硬隔离);**F31** 让每个工作区可各自团队同步。
