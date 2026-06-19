---
title: F20 · 智能写入(去重 / 合并 / 追加)
type: plan
owner: PM
status: done
priority: P0
effort: M
round: R4
created: 2026-06-17
completed: 2026-06-18
tags: [agent, mcp, 写入, 数据质量]
---

# F20 · 智能写入(去重 / 合并 / 追加)

> 一句话:让 agent 经 MCP 写文档时**先看有没有近似的已存在文档**,据此选择 追加 / 合并 / 新建 / 升版,而不是每次都新建一篇近似重复或静默覆盖——守住"agent 写出干净过程文档"的初衷。

## 背景与痛点

写入侧目前是"无脑写",这恰恰发生在 docky 最核心的场景(agent 落文档):

- `writeDoc` 直接 `writeFileSync(dest)` 创建或覆盖,**无任何去重/合并**(`src/core.ts`);MCP `write_doc` 同样(`src/mcp.ts`)。
- 后果:agent 跨会话反复写,容易产生 `login-debug.md`、`登录排查.md`、`session-issue.md` 三篇**讲同一件事**的近似重复;或同名时**静默覆盖**已有内容。
- R2 的 F10 给**人类**的删除/覆盖加了护栏,F07 解决**读**;但 **agent 的写**这条最高频路径仍裸奔。

## 目标 / 非目标

**目标**
- 写入前**相似性检测**:按 名称/标题/正文相似度(复用 F13 排序与 `src/match.ts`,辅以 F12 链接关系)找出疑似重复。
- `write_doc` 增 `mode: new | append | merge | replace`(默认 `new` 但**命中近似时不静默执行**,而是返回候选与建议)。
- 命中已存在同名/近似时:
  - `append`:把新内容作为带时间戳的小节追加;
  - `merge`:返回合并建议(保留双方,标注差异)供 agent/人确认;
  - `replace`:需显式 `mode` 才覆盖(等同 F10 的覆盖保护,对 agent 生效)。
- 返回结构化提示(命中了哪篇、相似度、建议动作),让 agent 能据此决策。

**非目标**
- 不做内容级 LLM 自动合并(本轮给"结构化建议 + 安全追加",真合并由调用方决定)。
- 不改人类侧 `add`(那条由 F10 覆盖保护负责)。

## 用户故事

- 作为编码 agent,我要写"登录排查",`write_doc` 提示"已存在 debug/登录排查.md(相似度 0.82),建议 append",我便追加而非新建第 N 篇。
- 作为维护者,我不再在库里发现一堆讲同一件事的近似重复文档。

## 交互设计(工具契约)

```jsonc
// write_doc 命中近似时的返回
{
  "status": "duplicate_suspected",
  "candidate": { "rel": "debug/登录排查.md", "similarity": 0.82 },
  "suggestion": "append",
  "hint": "再次调用并指定 mode=append|merge|replace 以继续"
}
```

## 技术落点

- `src/core.ts`:`writeDoc` 前置 `findSimilar(vault, project, {name,title,content})`(复用 F13 评分 / `match.ts`);新增 `appendDoc`、`mergePreview`;`replace` 走 F10 的覆盖保护语义。
- `src/mcp.ts`:`write_doc` 增 `mode` 入参与"疑似重复"返回;默认安全(不静默覆盖)。
- 写入成功后(配合 F08)自动提交,使任何写入可回溯/回滚。

## 验收标准

- [x] 写入前进行相似性检测,命中近似时返回候选 + 相似度 + 建议动作(不静默执行)。
- [x] `mode=append` 以带时间戳小节安全追加;`mode=replace` 才覆盖。
- [x] `merge` 返回可读的合并建议(保留双方、标差异)。
- [x] 人类侧 `add`/`write` 行为不变(由 F10 负责);agent 侧写入受本特性约束。
- [x] `findSimilar`/`appendDoc` 有单测;作用域隔离与 F08 提交不受影响。

## 衡量指标

- 库内近似重复文档数量显著下降。
- agent 写入中走 append/merge(而非新建重复)的比例。

## 风险与依赖

- 相似度阈值需保守,避免误判把不同主题判为重复(给相似度让调用方决策)。
- 依赖 F13(相似度)/F12(关系);二者缺席时退化为"同名保护 + 基础名称相似"。

## 与其他提案的关系(迭代递进)

- **补齐写入侧最后一块**:F07 解决"读"、F10 解决"人类删/改"、F20 解决"agent 写"。
- **复用 F13/`match.ts`** 做相似度、**F12** 做关系、**F08** 做可回溯提交。
- 与 **F19 巡检** 呼应:F20 在写入端**预防**重复,F19 在存量端**发现**问题。

## 实现记录

- done — 2026-06-18 实现并通过测试(210/210)。
  - `src/core.ts`:`textSimilarity`(字符 bigram Jaccard,免分词、兼容中英文)、`findSimilar(vault, project, {name,title,content})`(综合名称/标题/正文前缀相似度,阈值 0.3,best-first)、`appendDoc`(带时间戳 `## 追加 <ts>` 小节安全追加)、`mergePreview`(保留双方的可读合并预览,不自动合并)、`smartWrite(... mode)`:
    - `new`(默认):命中同名或近似 → 返回 `duplicate_suspected{candidate, similarity, suggestion, hint}` **不静默写**;无冲突才写。
    - `append`/`replace`/`merge` 为显式动作(append 追加、replace 覆盖、merge 返回 `merge_preview`)。
  - `src/mcp.ts`:`write_doc` 增 `mode` 入参,改走 `smartWrite`,**默认不再静默覆盖/重复**;`scaffold`(F06)保留。
  - 人类侧 `add`/`write` 行为不变(覆盖保护归 F10);写入成功经 F08 自动提交可回溯;作用域隔离不变。
  - 测试:`test/core.test.ts`(textSimilarity 高/低、findSimilar 命中近似排除无关、appendDoc 时间戳小节保留原文、smartWrite new 无冲突写入 / 同名拒覆盖 / 异名近似也拒 / append·replace·merge 显式)。并经真实 MCP stdio 实测 `write_doc` 同名返回 duplicate_suspected(未覆盖)+ `mode=append` 追加。
  - 备注:不做内容级 LLM 自动合并(给结构化建议 + 安全追加,真合并由调用方决定,非目标);相似度阈值保守,最终由 agent 据 similarity 决策。
  - 加固(2026-06-18):`smartWrite` 的 `replace` 覆盖前先经 `backupOverwrite` 把旧内容备份进 `.trash`(与 F10 一致)→ 被覆盖的旧版可 `docky undo` 还原,覆盖不再不可逆;新增回归测试 "smartWrite 'replace' backs up the old content so undo restores it"(全量 238/238 绿)。至此 agent 写入的 **覆盖保护闭环**:同名/近似默认不写(`new`)→ 显式 `replace` 也可撤销。
