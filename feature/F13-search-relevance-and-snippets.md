---
title: F13 · 检索质量升级(排序 + 多片段 + 高亮)
type: plan
owner: PM
status: proposed
priority: P0
effort: M
round: R3
created: 2026-06-17
tags: [检索, 排序, mcp]
---

# F13 · 检索质量升级(排序 + 多片段 + 高亮)

> 一句话:把 `searchDocs` 从"子串匹配、每篇一条片段、按文件名排"升级为**相关性排序 + 每篇多片段 + 命中高亮(可选模糊)**,让 F01 的交互结果与 F07 的 agent 包都更准。

## 背景与痛点

F01 让搜索结果**能交互**了,但**底层算法仍很弱**——F01 当初就明确"不改变匹配算法",这块缺口至今未补:

- `searchDocs` 命中后立即 `break`,**每篇只给一条片段**(`src/core.ts`),且**无评分排序**,结果顺序就是 `listDocs` 的**文件名字母序**(`core.ts`)。
- 纯 `toLowerCase().includes` 子串匹配(`core.ts`),没有"标题命中 > 正文命中"的权重,没有命中次数/新鲜度因素,也**没有命中高亮**。
- 这直接拖累两类用户:人(F01 结果列表排序无意义)与 agent(F07 的 `get_context` 依赖检索质量)。

## 目标 / 非目标

**目标**
- **相关性排序**:标题/文件名命中 > 正文命中;命中次数、`status`(F03,active 加权、archived 降权)、最近访问(F04)纳入打分。
- **每篇多片段**:返回前 N 条匹配片段(去重、含行号),而非只第一条。
- **命中高亮**:片段中对查询词加亮(在 F01 的 results 列表与分页器中可见)。
- **可选模糊**:复用 F02 的 `src/match.ts` 做容错匹配(`--fuzzy`)。
- 同一套增强同时服务 TUI(F01)与 MCP(`search_docs` / F07 `get_context`)。

**非目标**
- 不做向量/embedding 语义检索(仍属路线图后续轮次)。
- 不改变作用域隔离与命中数据的对外结构(仅扩展字段)。

## 用户故事

- 作为开发者,我搜 `session`,最相关的设计稿**排在最前**,且能看到它命中的**多处上下文**,而不是字母序里随机一条。
- 作为 agent,我经 `get_context` 拿到的候选是**按相关性排好序**的,少读无关文档。

## 交互设计

```
search: session                         (按相关性 · 12 命中)
design/  架构.md            ★0.94  L42 …创建 「session」 时写缓存…  L88 …「session」 过期…
debug/   登录排查.md        ★0.61  L13 …「session」 丢失导致 302…
```

## 技术落点

- `src/core.ts`:重写 `searchDocs` 为打分 + 收集多片段(去掉无条件 `break`);新增 `SearchHit.score`、`snippets[]`、高亮区间。复用 `match.ts` 做可选模糊与子序列评分。
- 排序信号接 F03(status)/F04(recents);缺席时优雅降级为纯文本相关性。
- `src/tui.tsx`(results)与 `src/mcp.ts`(search_docs / get_context)消费新结构与高亮。

## 验收标准

- [ ] 结果按相关性排序(标题命中、频次、status、recency 可解释)。
- [ ] 每篇返回多片段(上限 N,含行号、去重)。
- [ ] 命中词在 results 列表与分页器中高亮。
- [ ] `--fuzzy` 走 `match.ts`,默认精确。
- [ ] MCP `search_docs`/`get_context` 同步受益;作用域隔离不变。
- [ ] `searchDocs` 打分/多片段/高亮有单测(参考 `test/core.test.ts`)。

## 衡量指标

- 搜索后点击的命中**平均排名**下降(越靠前越好)。
- agent 经 get_context 的"无关读取"比例下降。

## 风险与依赖

- 多片段 + 打分会增加扫描开销;对大文档限制扫描行数/片段数。
- 高亮需在终端渲染中正确处理 ANSI,避免破坏 marked-terminal 输出。

## 与其他提案的关系(迭代递进)

- **补全已交付 F01 明确遗留的"算法那一半"**:F01 管交互,F13 管相关性。
- **复用已交付 F02** 的 `src/match.ts`;**直接增强 F07** 的 agent 上下文质量。
- 与 **F12** 互补:相关性(F13)+ 显式引用(F12)= 更全的"相关文档"。
