---
title: F42 · 里程碑快照
type: plan
owner: PM
status: proposed
priority: P1
effort: S
round: R9
created: 2026-06-18
tags: [留痕, 里程碑, git]
---

# F42 · 里程碑快照

> 一句话:给整库打一个**命名里程碑**(如"v1.0 设计冻结""Q2 评审基线"),日后能列出、对比、按里程碑回看文档当时的样子。

## 背景与痛点

F08 已交付,但它是**逐篇**的:

- F08 提供自动提交、`docky log/diff <rel>`、`sync`(`src/core.ts`/`cli.ts`)——能看**单篇**怎么演变。
- 但**没有"整库某时刻的命名基线"**:想标记"这是 v1.0 评审通过的全部设计""这是 Q2 冻结点",并日后整体回看/对比,**无解**。
- 团队评审、版本冻结、复盘都需要"那一刻的全库状态",目前只能靠记 commit 哈希。

## 目标 / 非目标

**目标**
- `docky snapshot <名称> [-p 项目] [-m 说明]`:在当前点打一个**命名快照**(git tag),记录全库/该项目当时状态。
- `docky snapshots`:列出所有里程碑(名称/时间/说明)。
- `docky snapshot diff <A> <B>`:两个里程碑之间**新增/改动/删除**了哪些文档(复用 F08 diff)。
- **按里程碑回看**:读取某篇"截至快照 X"的版本(复用 F08 read-at-rev)。

**非目标**
- 不做分支/回滚整库(只读回看;真要回滚交给 git)。
- 不替代 F08 的逐篇历史(F42 是全库命名基线)。

## 用户故事

- 作为负责人,评审通过后我 `docky snapshot v1.0-design -m "评审基线"`,日后随时回看那一刻的全部设计。
- 作为复盘者,`docky snapshot diff v1.0 v1.1` 一眼看清两版之间设计怎么变的。

## 交互设计

```
$ docky snapshot v1.0-design -m "评审基线"
✓ 里程碑 v1.0-design 已记录(42 篇)
$ docky snapshots
  v1.0-design   2026-06-18  评审基线
$ docky snapshot diff v1.0-design HEAD
  + debug/上线排查.md   ~ design/鉴权改造.md
```

## 技术落点

- `src/core.ts`:`createSnapshot`(git tag,复用既有 `git()`)、`listSnapshots`、`diffSnapshots`、`readAtRev`(F08 已有 diff/log 基础)。
- `src/cli.ts`/`commands.ts`:`snapshot` / `snapshots` 命令;TUI `/snapshots`。
- 作用域:`-p` 限定项目;diff 仍经 `safePath`。

## 验收标准

- [ ] `docky snapshot <名>` 打命名里程碑;`snapshots` 列出。
- [ ] `snapshot diff <A> <B>` 显示两里程碑间的增/改/删文档。
- [ ] 可读取某篇"截至某快照"的版本。
- [ ] 无 git 时优雅降级提示;`createSnapshot/diffSnapshots` 有单测。

## 衡量指标

- 使用里程碑做评审/复盘的频次。
- "回看历史基线"需求被满足(不再靠记 commit)。

## 风险与依赖

- tag 命名冲突需校验;大库 diff 走分页(沿用 F01 suspend-Ink)。
- **建立在 F08** 的 git 基础上;与 F21 仪表盘(里程碑维度)、F28(变更动态)互补。

## 与其他提案的关系(迭代递进)

- 把 **F08 的逐篇留痕**升级为**全库命名里程碑**,服务评审/冻结/复盘。
- 与 **F28** 互补:F28 是"自上次以来"的增量,F42 是"命名基线"的对比。
