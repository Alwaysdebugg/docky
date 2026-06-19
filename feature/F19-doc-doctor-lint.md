---
title: F19 · 文档质量巡检(doctor / lint)
type: plan
owner: PM
status: done
priority: P0
effort: M
round: R4
created: 2026-06-17
completed: 2026-06-18
tags: [治理, 质量, 健康度]
---

# F19 · 文档质量巡检(doctor / lint)

> 一句话:`docky doctor` 一条命令把整个文档库体检一遍——缺 frontmatter、没标题、断链、陈旧、未提交、游离文件——给出报告与 `--fix` 一键修复,防止知识库随增长而腐化。

## 背景与痛点

随着文档越攒越多,**没有任何机制发现"坏味道"**:

- 没有校验/审计入口:`listDocs` 容错地把缺 frontmatter 当 `active`(F03 实现),坏味道被**默默吞下**而非被发现。
- 典型问题散落各处且无人汇总:
  - 缺/非法 frontmatter、不符合 F06 模板;
  - **无标题**(`readDocMeta` 回退到文件名,`core.ts`)——拖累 F02/F13 检索;
  - **断链**(F12 的 `[[..]]` 指向不存在文档);
  - **陈旧**(F03 已能判定 `stale`,但需主动 `--stale` 才看得到);
  - **未提交**(F08:vault 可能一堆未提交改动);
  - **游离文件**(落在类型目录之外、不被 `listDocs` 收录)。

## 目标 / 非目标

**目标**
- `docky doctor [-p 项目]` / 别名 `docky lint`:输出按严重度分级的体检报告(error/warn/info),每条含**问题 + 位置 + 修复建议**。
- `docky doctor --fix`:执行**安全自动修复**——补默认 frontmatter(F06 模板)、设默认 `status`、重建 INDEX、可选提交(F08)。
- TUI `/doctor`:交互式查看,逐条跳转到文档(复用 F01)。
- 退出码非零(供 CI/hook 使用),与现有 `docky hooks` 体系呼应。

**非目标**
- 不做内容质量的语义评判(只查结构/一致性/可达性这类客观问题)。
- 不自动删除任何文件(清理交给 F10/F11)。

## 用户故事

- 作为维护者,我每周 `docky doctor` 看健康报告,`--fix` 把能自动修的补齐,人工处理断链与陈旧。
- 作为团队,我把 `docky doctor` 接进 CI,frontmatter 不合规就红。

## 交互设计

```
$ docky doctor -p my-app
✗ error  design/草稿.md         缺 frontmatter            → --fix 可补
⚠ warn   debug/排查.md          [[登录流程]] 断链          → 见 F12
⚠ warn   plan/旧路线.md         陈旧 71 天(active)        → /status archived
ℹ info   3 处未提交改动                                    → docky sync
汇总:1 error · 2 warn · 1 info   (--fix 可自动修 1 项)
```

## 技术落点

- 新增 `src/lint.ts`:一组纯函数检查器(frontmatter/title/link/stale/uncommitted/orphan),输入 `listDocs` 结果 + 文件内容,输出结构化 issue 列表;`--fix` 调 `setStatus`(F03)/`scaffold`(F06)/`generateIndex`/`commitVault`(F08)。
- `src/cli.ts` / `src/commands.ts`:`doctor`/`lint` 命令与 `/doctor`;非零退出码。
- 复用:F12 断链检测、F03 陈旧判定与 `setStatus`、F08 未提交查询。

## 验收标准

- [x] `docky doctor` 报告覆盖:缺/非法 frontmatter、无标题、断链、陈旧、未提交、游离文件。
- [x] 每条 issue 含严重度、位置、修复建议;有汇总与非零退出码。
- [x] `--fix` 仅做安全修复(补 frontmatter/设默认状态/重建 INDEX),不删文件。
- [x] TUI `/doctor` 可逐条跳转(复用 F01)。
- [x] `src/lint.ts` 各检查器有单测;作用域隔离不变。

## 衡量指标

- 报告中的 error/warn 数随时间下降(库在变健康)。
- `--fix` 自动修复占总修复的比例。

## 风险与依赖

- `--fix` 必须保守且幂等;改动经 F08 提交以可回滚。
- 部分检查依赖尚未上线的提案(F12 断链、F08 未提交):缺席时该项跳过并标注"未启用"。

## 与其他提案的关系(迭代递进)

- **巡检并收口前序成果**:审计 F03(陈旧/状态)、F06(frontmatter/模板)、F08(未提交)、F12(断链)。
- 与 **F18** 互补:F18 定义"该怎样",F19 检查"是否如此",二者构成 docky 的治理闭环。

## 实现记录

- done — 2026-06-18 实现并通过测试(203/203)。
  - `src/lint.ts`(新增):纯检查器 `missingFrontmatter` / `missingTitle`(去 frontmatter 后无 `#` 标题)/ `findOrphans`(类型目录之外的 .md);`lintProject(vault, project)` 汇总六类 issue(缺 frontmatter=error、无标题/断链(F12)/陈旧(F03)/游离=warn、未提交(F08)=info,按严重度排序,每条含位置 + 修复建议 + 是否可自动修);`fixProject` 仅做**安全幂等修复**——补 frontmatter(经 `setStatus` 让 gray-matter 落地 frontmatter)、重建 INDEX、`commitVault` 提交,**绝不删文件**。
  - `src/cli.ts`:`docky doctor`(别名 `lint`)`[--fix]`——彩色分级报告 + 汇总 + **有 error 则退出码非零**(供 CI/hook)。
  - `src/tui.tsx`:`/doctor` 进入可选中 issue 列表,Enter 跳到出问题的文档(复用 F01 `openDoc`)。
  - `src/commands.ts`:`/doctor` 文本兜底(非 TUI 上下文)。
  - 复用:F12 断链、F03 陈旧/`setStatus`、F08 `uncommittedCount`/`commitVault`;缺席提案对应检查自动跳过。作用域隔离不变(仅经 `listDocs`/`safePath`)。
  - 测试:`test/lint.test.ts`(frontmatter/title 检查、findOrphans、lintProject 多类 issue + 排序、`--fix` 补 frontmatter 清除 error 且不删文件 + 保留正文、健康项目空报告)+ `test/tui.test.tsx`(`/doctor` 列表含 frontmatter 问题)。CLI 实测报告/严重度/退出码 1→0、`--fix` 自动修。
  - 备注:`--fix` 只补 frontmatter/重建 INDEX/提交(保守安全);断链/陈旧/游离需人工处理(不自动删,清理交 F10/F11)。
