---
title: F07 · 给 Agent 的一站式上下文包
type: plan
owner: PM
status: done
priority: P0
effort: M
round: R2
created: 2026-06-17
completed: 2026-06-17
tags: [agent, mcp, 检索]
---

# F07 · 给 Agent 的一站式上下文包

> 一句话:新增 MCP 工具 `get_context`,让 AI agent **一次调用**就拿到当前项目里**排序好、去陈旧、带摘要**的相关文档包,而不是反复 list→read 自己拼。

## 背景与痛点

docky 的差异化价值是"给 agent 喂对的过程文档",但当前 MCP 把拼装成本全甩给了 agent:

- MCP 仅提供 `resolve_project / list_docs / read_doc / search_docs / write_doc`(README「MCP」表)。agent 要先 `list_docs`,再**逐篇 `read_doc`**,自己判断该读哪些——多轮往返、易超预算、易读到过时内容。
- `list_docs` 无相关性/新鲜度排序(`core.listDocs` 仅按文件名排序,`core.ts`);`search_docs` 每篇只给一条片段(`core.searchDocs`,`core.ts`),不利于 agent 直接决策。
- 没有"按 token 预算返回最相关的一束"的能力,agent 往往要么读太多、要么漏关键设计。

## 目标 / 非目标

**目标**
- 新增 MCP 工具 `get_context(project, query?, budget?)`,返回**有序的文档包**:每项含 `rel / title / type / status / 摘要(或匹配片段)`,并在给定 token 预算内截断。
- 排序信号:与 `query` 的相关性(复用 F01 检索)+ `status`(F03,优先 active、排除 archived)+ 最近访问(F04)。
- 无 `query` 时返回"项目概览包":INDEX 摘要 + 最近活跃的 design/plan + 置顶。
- 严格遵守作用域隔离(复用 `safePath`),越界一律拒绝。

**非目标**
- 不做向量/embedding 语义检索(路线图后续轮次);本轮用关键词 + 元数据排序。
- 不替代 `read_doc`(需要全文时仍单独读)。

## 用户故事

- 作为编码 agent,我在动手前调用 `get_context(project, "登录鉴权")`,一次拿到 3–5 篇最相关且仍 active 的设计/排查文档摘要,直接进入工作。
- 作为 agent,我不想读到已 `archived` 的旧方案——上下文包默认已帮我滤掉。

## 交互设计(工具契约)

```jsonc
// 入参
{ "project": "my-app", "query": "登录鉴权", "budget": 4000 }
// 返回
{
  "project": "my-app",
  "items": [
    { "rel": "design/鉴权改造.md", "type": "design", "status": "active",
      "title": "鉴权改造", "score": 0.91, "excerpt": "…匹配/摘要…" }
  ],
  "truncatedBy": "budget",        // 或 null
  "note": "已排除 2 篇 archived"
}
```

## 技术落点

- `src/mcp.ts`:注册 `get_context` 工具(zod 入参校验,沿用现有工具风格)。
- `src/core.ts`:`buildContext(vault, project, {query, budget})` —— 组合 `listDocs`+`searchDocs`,按 status/recents 加权排序,生成摘要(取 frontmatter 摘要或正文首段),按预算贪心截断。
- 复用 F03 的 `status`、F04 的 recents 数据(若已上线;未上线则降级为按文件名+匹配度)。

## 验收标准

- [x] MCP 暴露 `get_context`,入参 `project` 必填、`query/budget` 可选。
- [x] 返回项有序,带 `title/type/status/excerpt/score`,并在超预算时截断且标注 `truncatedBy`。
- [x] 默认排除 `archived`,优先 `active`;无 query 时返回项目概览包。
- [x] 越界/跨项目文档绝不出现;`safePath` 仍是硬边界。
- [x] `buildContext` 排序与截断有单测(参考 `test/core.test.ts`)。

## 衡量指标

- agent 组装上下文的 MCP 调用次数(目标:多次 list+read → 1 次 get_context)。
- agent 读到 archived/过时文档的比例下降。

## 风险与依赖

- 摘要质量:首版用 frontmatter 摘要/正文首段即可,不引入 LLM 摘要。
- 预算估算用粗略 token≈字符/N 近似,避免引入分词依赖。
- 依赖 F03(status)/F04(recents)以发挥最佳排序;二者缺席时可优雅降级。

## 与其他提案的关系(迭代递进)

- **复用 R1 的 F01**(检索)做相关性、**F03**(状态)做新鲜度过滤、**F04**(最近)做权重——R2 首个"把 R1 能力对外服务化"的提案。
- 是 docky 面向 **agent 用户**体验的核心补强,与面向人类的 F01/F02 呼应。

## 实现记录

- done — 2026-06-17 实现并通过测试(124/124)。
  - `src/core.ts`:`buildContext(vault, project, {query?, budget?})` 返回 `ContextBundle { project, items[], truncatedBy, note }`;每项 `{rel, type, status, title, tags, score, excerpt}`。
  - 排序信号:相关性(query 命中——标题/名/标签/正文出现次数加权,复用 `searchDocs` 取片段)+ 状态新鲜度(active>draft>done,F03,**archived 经 `filterDocs` 排除**)+ 最近/置顶权重(F04)+ design/plan 轻微加权 + stale 扣分;三者缺席自动降级。
  - 摘要:优先取 query 命中片段,否则正文首段(跳过 frontmatter/标题,截断 160 字),再否则标题——不引入 LLM。
  - 截断:token≈字符/4 粗估,给 budget 时贪心装箱(至少返回 1 项)并标 `truncatedBy:"budget"`;无 budget 时取 Top-8,超出标 `"count"`。
  - 无 query 时返回项目概览包(按状态/最近排序);`note` 标注已排除的 archived 数量与"无命中转概览"。
  - `src/mcp.ts`:注册 `get_context` 工具(zod 校验,`project` 必填、`query/budget` 可选),复用既有作用域隔离。
  - 测试:`test/core.test.ts`(排序/archived 排除/excerpt/note、budget 截断、无 query 概览、pin+recent 加权、跨项目隔离);并经真实 MCP stdio 传输实测 `get_context` 返回正确包、排除 archived。
  - 备注:本轮为关键词 + 元数据排序,语义/embedding 检索留待后续轮次(非目标)。
