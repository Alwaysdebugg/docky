---
title: F11 · 多选批量操作
type: plan
owner: PM
status: done
priority: P1
effort: M
round: R3
created: 2026-06-17
completed: 2026-06-17
tags: [效率, tui, 批量]
---

# F11 · 多选批量操作

> 一句话:在浏览器里**多选**文档,一次性 `移动 / 删除 / 打标 / 改状态`,把"整理文档库"从逐条点变成批处理。

## 背景与痛点

R1 让列表能交互了,但仍是**单选单动作**,整理大批文档很痛:

- 浏览器 `mode === "browse"` 只有单个 `browseSel` 索引,Enter 仅预览一篇(`src/tui.tsx`,F01 实现记录亦同);`results` 模式同样单选。
- 要把 10 篇 debug 改归类、或批量删除一批过期稿,只能一条条 `/mv`、`/rm`——重复且易错。
- **顺带发现**:F01 当初建议抽出的共享 `selectableList` 组件**并未落地**——`results / browse / projects / quickopen` 四处各自渲染行(`grep selectableList` 无结果)。多选需要的正是这层公共能力,F11 一并把它补上。

## 目标 / 非目标

**目标**
- 浏览器支持多选:`Space` 勾选/取消、`a` 全选、`A` 反选,选中项有清晰勾标。
- 对选中集执行批量动作:`m` 批量移动到某类型、`d` 批量删除(走 F10 安全删除)、`#` 批量打标、`s` 批量改 `status`(F03)。
- 整批动作配合 F08 形成**一条可回滚提交**(而非 N 条)。
- 抽出共享 `<SelectableList>` 组件,统一 results/browse/projects/quickopen 的选择交互。

**非目标**
- 不做跨项目批量(遵守作用域;跨项目归 F15)。
- 不做复杂筛选表达式(用 F03 的 `--status/#tag` 先收窄再批量)。

## 用户故事

- 作为维护者,我 `/list debug`,`a` 全选过期项,`s archived` 一键归档,再 `d` 清掉无用稿——一条提交搞定。
- 作为整理者,我多选若干 prompts,`m design` 批量改归类。

## 交互设计

```
my-app · debug  (8 篇 · 已选 3)
debug/
  [x] ▸ 登录排查.md
  [x]   超时排查.md
  [ ]   缓存排查.md
Space 选 · a 全选 · m 移动 · d 删除 · # 打标 · s 状态 · Esc 返回
```

## 技术落点

- 新增 `src/components/SelectableList.tsx`,把当前散落在四个 mode 的行渲染/导航收敛进来,并加 `selection: Set<rel>`。
- `src/tui.tsx`:browse/results 接入多选;批量动作循环调用 `core.moveDoc/removeDoc` 等,外层包一次 `commitVault`(F08)。
- 批量删除复用 F10 的回收站 + 确认。

## 验收标准

- [x] 浏览器可多选(Space/a/A),有可见勾标与"已选 N"。
- [x] 批量 移动/删除/打标/改状态 生效,且整批为一次提交(F08)。
- [x] 批量删除走 F10 安全删除(可 restore/undo)。
- [x] 抽出的 `SelectableList` 被 results/browse/projects/quickopen 复用,行为不回退。
- [x] 作用域隔离不被绕过;新增/更新单测(参考 `test/tui.test.tsx`)。

## 衡量指标

- 整理大批文档(≥5 篇)所需操作数显著下降。
- 批量动作占 mv/rm/打标总量的比例。

## 风险与依赖

- 批量删除破坏性大:强制确认 + 走回收站(F10)。
- 共享组件重构需保证四个既有模式零回退(先补测试再重构)。

## 与其他提案的关系(迭代递进)

- **承接已交付的 F01**:补上其遗留的共享 `selectableList` 重构,并把交互从单选升级为多选。
- **依赖 F03**(打标/状态)、**F08**(单次提交)、**F10**(安全批删)——R3 首个"把 R1/R2 能力规模化"的提案。

## 实现记录

- done — 2026-06-17 实现并通过测试(151/151)。
  - `src/components/SelectableList.tsx`(新增):落地 F01 遗留的共享可选中列表组件(分组表头 + 光标高亮 + 可选 `[x]/[ ]` 复选框);**已被 browse / results / projects / quickopen 四处复用,既有 TUI 测试零回退**。
  - `src/core.ts`:`removeDoc/moveDoc/setStatus` 增 `noCommit`;新增 `addTags`(合并标签去重)与批量函数 `batchRemove/batchMove/batchSetStatus/batchAddTags`——逐项 `noCommit` 执行、末尾一次 `autoCommitVault`,**整批 = 一条 F08 提交**;`BatchResult { ok, errors }` 收集逐项错误而不中断。
  - `src/tui.tsx`:browse 多选(`Space` 勾选 / `a` 全选 / `A` 反选,标题显示"已选 N");批量动作 `m` 移动 / `d` 删除 / `#` 打标 / `s` 改状态——`d` 走 F10 回收站确认(`confirm` 支持批量),`m/s/#` 经新 `batchInput` 模式输入参数;选区为空时回退到光标所在项。
  - 批量删除复用 F10 软删除(可 `/undo`、`restore`);作用域隔离不被绕过(批处理逐项经 `safePath`)。
  - 测试:`test/core.test.ts`(批量改状态/移动/打标/删除均单条提交、逐项错误收集)+ `test/tui.test.tsx`(多选 + 批量改状态落库、批量删除入回收站 + 确认);四模式迁移到 `SelectableList` 后既有 23 个 TUI 测试全绿。
  - 备注:本轮一并兑现 F01 当初提出、却一直未落地的共享 `SelectableList` 抽取;批量 move/tag 用 `batchInput` 取参,未做内联多步编辑(非目标)。
