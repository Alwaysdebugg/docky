---
title: F31 · 团队协作同步(拉取 / 冲突 / 归属)
type: plan
owner: PM
status: proposed
priority: P1
effort: L
round: R7
created: 2026-06-17
tags: [团队, 协作, git, 同步]
---

# F31 · 团队协作同步(拉取 / 冲突 / 归属)

> 一句话:在 F08 已有的"自动提交 + 单向 push"之上,补齐**双向同步、冲突引导、写入归属与远程引导**,让一个 vault 能被团队(以及多台机器/多个 agent)安全共享。

## 背景与痛点

F08 已交付,但它是**单机 + 单向**的:

- F08 提供自动提交与 `docky sync --push`(`src/cli.ts`,`core.syncVault(v, push)`)——但**只 push 不 pull**:拿不到队友/另一台机器的更新。
- **没有冲突处理**:两人改同一篇 → git 冲突,docky 层面无任何引导。
- **没有归属**:提交都落在某台机器的 git 身份下,**分不清是谁/哪个 agent 写的**(F28/F21 也就无从按人/agent 聚合)。
- **没有远程引导**:新同事在新机器上**如何克隆/接上这个共享 vault**,完全没有路径。

## 目标 / 非目标

**目标**
- **双向同步**:`docky sync` = 先 `pull --rebase` 再 push;`docky pull` 单独可用。
- **冲突引导**:检测冲突文档 → 列出 → 逐篇"用我的/用对方/手动合并"(复用 F08 diff、F01 预览)。
- **写入归属**:每次写带 author(机器/用户/agent 身份,经 F18 配置),在 `log`/F28/F21 中可按归属聚合。
- **远程引导**:`docky clone <remote>`(在新机器接上共享 vault)、`docky remote set <url>`。

**非目标**
- 不自建同步服务器(复用用户既有 git remote:GitHub/GitLab/自建)。
- 不做实时协同编辑(异步 git 协作即可)。

## 用户故事

- 作为团队成员,我 `docky sync` 既推送我的更新,也拉回队友昨天写的设计与排查。
- 作为新同事,我 `docky clone <仓库地址>`,一条命令接上团队共享 vault。
- 作为维护者,我能看到"这篇是 agent@CI 写的、那篇是张三改的"。

## 交互设计

```
$ docky sync
↓ 拉取 3 篇更新(design×1, debug×2)
⚠ 冲突:design/鉴权改造.md  [m 手动 / o 用我的 / t 用对方]
↑ 推送 2 篇
✓ 同步完成(归属:you@macbook)
```

## 技术落点

- `src/core.ts`:`syncVault` 扩展为 pull(--rebase)+ 冲突检测 + push;新增 `pullVault`、`resolveConflict`、`cloneVault`、`setRemote`。
- 归属:提交时设置 `GIT_AUTHOR_*`(来自 F18 的 identity 配置或环境);agent 写入带 `agent` 标识。
- 冲突 UI:复用 F08 `diffDoc` 与 F01 预览;CLI/TUI 入口。

## 验收标准

- [ ] `docky sync` 双向(pull--rebase 后 push);`docky pull` 可单独用。
- [ ] 冲突被检测并提供"用我的/用对方/手动"的逐篇引导。
- [ ] 写入带归属,`log`/F28/F21 可按归属聚合。
- [ ] `docky clone <remote>` / `remote set` 可引导新机器接入。
- [ ] 无 remote 时优雅降级为本地(F08 行为不变);同步逻辑有单测。

## 衡量指标

- 多人/多机共享同一 vault 的数量(团队采纳)。
- 同步冲突的成功解决率;因未同步导致的内容分叉减少。

## 风险与依赖

- 冲突合并需谨慎,默认不自动覆盖,优先人工选择。
- **依赖 F08**(提交/diff 基础)、F18(身份配置);远程鉴权交给用户既有 git 配置。

## 与其他提案的关系(迭代递进)

- **在已交付 F08 之上**把"单机单向"升级为"团队双向 + 冲突 + 归属"。
- 归属数据反哺 **F28 变更动态**(谁改的)、**F21 仪表盘**(按人/agent);与 **F32 多 vault**(每个工作区各自远程)、**F15**(作用域)协同。
