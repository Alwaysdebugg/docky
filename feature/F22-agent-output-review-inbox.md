---
title: F22 · Agent 产出审阅收件箱
type: plan
owner: PM
status: done
priority: P0
effort: M
round: R5
created: 2026-06-17
completed: 2026-06-18
tags: [agent, 治理, 审阅, 协作]
---

# F22 · Agent 产出审阅收件箱

> 一句话:把 agent 写进库的文档汇成一个**待审阅收件箱**,人类可逐篇 通过 / 编辑 / 退回 / 合并,让"agent 自动落文档"在规模化后仍可控、可信。

## 背景与痛点

docky 的立身之本是"agent 把过程文档落进中心库",但**产出无人把关**:

- agent 经 MCP `write_doc` 写入(`src/mcp.ts`),F20 会做写时去重,但**没有任何事后人工审阅环**——agent 跨会话写的几十篇,人类可能从没看过。
- 现有 frontmatter 没有"来源/审阅状态"概念(`buildFrontmatter` 只有 project/type/title/created/branch,`core.ts`;F03 加了 status/tags),无法区分"人写的"与"agent 写的待审的"。
- 结果:库里混着大量未经核对的 agent 产出,质量与可信度随规模稀释——正是 docky 最该守住的东西。

## 目标 / 非目标

**目标**
- **标记来源**:`write_doc`(配合 F20)给 agent 写入打 frontmatter `source: agent` + `review: pending`。
- **收件箱**:`docky inbox` / TUI `/inbox` 列出 `review: pending`(可按"自上次审阅以来",借 F04 的访问/时间信息)。
- **逐篇处置**:预览(F01)→ **通过**(`review: approved`)/ **编辑**(`e`)/ **退回**(移入 F10 回收站)/ **合并**(F20 merge);支持**批量通过**(F11)。
- 处置写入经 F08 提交,留痕可回溯。

**非目标**
- 不阻塞 agent 写入(先落库再审,异步治理);不做多级审批流。
- 不替代 F19 的客观体检(F22 是人对内容的主观核对)。

## 用户故事

- 作为开发者,我每天 `/inbox` 扫一遍 agent 昨天写的 6 篇排查记录,4 篇通过、1 篇编辑、1 篇退回。
- 作为团队,我们约定"agent 产出默认 pending,合入主线前需 approved",库的可信度有保障。

## 交互设计

```
收件箱 · my-app  (5 篇待审 · agent 产出)
debug/
  ▸ 登录超时排查.md      agent · 2h 前   [Enter 预览]
    缓存击穿排查.md       agent · 1d 前
prompts/
    退款话术.md           agent · 1d 前
Enter 预览 · y 通过 · e 编辑 · x 退回 · m 合并 · a 全选 · Esc 返回
```

## 技术落点

- `src/types.ts` / frontmatter:新增 `source`(human|agent)、`review`(pending|approved)。
- `src/mcp.ts` + F20:agent 写入默认 `source:agent, review:pending`。
- `src/core.ts`:`listPending(vault, project)`;`setReview(rel, state)`(类比 F03 `setStatus`,改写 frontmatter + F08 提交)。
- `src/commands.ts` / `src/cli.ts`:`inbox` / `/inbox`(复用 F01 预览、F11 多选、F10 退回、F20 合并)。

## 验收标准

- [x] agent 经 MCP 写入的文档默认 `source:agent, review:pending`。
- [x] `docky inbox` / `/inbox` 列出待审文档,可预览。
- [x] 通过/编辑/退回/合并均生效并经 F08 提交;支持批量通过。
- [x] 人类自己写/通过的文档不再出现在收件箱。
- [x] 作用域隔离不变;`listPending`/`setReview` 有单测。

## 衡量指标

- 待审积压数(应被持续消化,而非无限增长)。
- approved 占 agent 产出比例;退回/编辑率(反映 agent 写作质量趋势)。

## 风险与依赖

- 不能因审阅阻断 agent 工作流(异步、先写后审)。
- 依赖 F20(打来源标)、F08(提交)、F03(frontmatter 改写范式)、F01/F10/F11(审阅 UI 复用)。

## 与其他提案的关系(迭代递进)

- **补齐 agent 写入的治理闭环**:F20 写时去重(预防)→ **F22 事后人工审阅**(把关)→ F19 客观体检(兜底)。
- 复用 **F08**(留痕)/**F04**(自上次以来)/**F01·F10·F11**(审阅交互)。

## 实现记录

- done — 2026-06-18 实现并通过测试(220/220)。
  - `src/types.ts` + `src/core.ts`:`DocInfo` 增 `source`/`review`,`readDocMeta`/`listDocs` 解析 frontmatter `source`/`review`;新增 `stampFrontmatter`(合并字段到 frontmatter,保留正文)、`listPending`(`review===pending`)、`setReview`(改写 frontmatter + 校验 + F08 提交)。
  - **来源标记**:`smartWrite`(F20,即 MCP `write_doc` 走的路径)在 new/replace/merge-write 时 `stampFrontmatter({source:agent, review:pending})`;append 后 `setReview(pending)` 让新内容重新进审。**人类侧 `add`/`writeDoc` 不经 smartWrite,不打标**(不进收件箱)。
  - `src/cli.ts`:`docky inbox`(列待审)、`docky review <rel> <pending|approved>`。
  - `src/tui.tsx`:`/inbox` 进入收件箱模式——多选(Space/a)、Enter 预览(F01)、`y` 通过(可批量)、`x` 退回(F10 回收站,可 /undo)、`e` 编辑;动作后自动刷新,清空即返回。
  - `src/commands.ts`:`/inbox` 文本兜底。
  - 异步治理:不阻塞 agent 写入(先落库后审);处置经 F08 可回溯;作用域隔离不变。
  - 测试:`test/core.test.ts`(agent 写入打 pending/human 不打、listPending 只返待审、setReview approved 出箱+保留正文、非法 state 拒)+ `test/tui.test.tsx`(`/inbox` 列待审 + `y` 通过清空)。**经真实 MCP stdio 实测**:agent `write_doc` → `source:agent/review:pending` → `inbox` 列出 → `review approved` → 出箱。
  - 备注:批量"通过"已支持(多选 + y);合并(merge)走 F20 的 `mode=merge` 在写入侧,收件箱聚焦 通过/退回/预览/编辑。
