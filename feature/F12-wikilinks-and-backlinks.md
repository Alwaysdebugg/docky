---
title: F12 · 文档互链与反向链接
type: plan
owner: PM
status: done
priority: P1
effort: M
round: R3
created: 2026-06-17
completed: 2026-06-18
tags: [知识图谱, 导航, 链接]
---

# F12 · 文档互链与反向链接

> 一句话:支持 `[[type/name]]` 维基式互链,自动计算**反向链接(被谁引用)**,让一篇篇孤立文档织成可导航的知识网。

## 背景与痛点

docky 的文档目前是**孤岛**,彼此无法关联:

- core 里没有任何"链接"概念——`listDocs`/`searchDocs`/`generateIndex`(`src/core.ts`)都只看单篇,不解析文档间引用。
- 一篇 `design/鉴权改造` 和它的 `debug/登录排查`、`plan/灰度计划` 明明强相关,却**无法从一篇跳到另一篇**,也看不到"这篇设计被哪些排查/计划引用"。
- 对比 docky 服务的对象(AI agent)与本仓库的 memory 体系都用 `[[links]]` 串联上下文——docky 自己的文档库反而没有。

## 目标 / 非目标

**目标**
- 文档正文支持维基链接 `[[design/鉴权改造]]` 或简写 `[[鉴权改造]]`(用 F02 的 `match.ts` 做模糊解析)。
- 渲染时把链接列为可跳转项:`/open` 分页器底部列出"出链",Enter 顺着跳(复用 F01 的 `pageDoc`)。
- **反向链接**:为每篇计算"被引用于…",在浏览器/`open`/INDEX 中展示。
- 失效链接检测:`[[…]]` 指向不存在的文档时标 ⚠(可在 INDEX 汇总)。

**非目标**
- 不做图形化关系图(首版用列表呈现出链/入链即可)。
- 不强制链接语法;无链接的文档照常工作。

## 用户故事

- 作为开发者,我在设计稿里写 `相关排查见 [[debug/登录排查]]`,日后从设计稿一跳即到。
- 作为维护者,我改一篇核心设计前,先看它的反向链接,知道**改动会牵连谁**。

## 交互设计

```
# 阅读 design/鉴权改造.md(分页器底部)
出链 →  [1] debug/登录排查   [2] plan/灰度计划
被引用 ←  prompts/鉴权话术 · debug/超时排查
(输入序号跳转,q 返回)
```

## 技术落点

- 新增 `src/links.ts`:`extractLinks(text)` 解析 `[[...]]`;`resolveLink(vault, project, raw)` 用 `match.ts` 模糊匹配到具体 `rel`;`buildBacklinks(vault, project)` 扫全项目构建反链索引。
- `src/core.ts` / `generateIndex`:INDEX 增"关系"区块与失效链接 ⚠。
- `src/pager.ts` / `src/tui.tsx`:阅读视图展示出链/入链并支持跳转(复用 F01 `pageDoc`)。
- 喂给 F07:`get_context` 可把"出链/入链"作为相关文档纳入上下文包。

## 验收标准

- [x] `[[type/name]]` 与 `[[name]]` 能被解析并模糊解析到正确文档。
- [x] 阅读视图列出可跳转的出链;反向链接正确展示。
- [x] 失效链接被标记;INDEX 汇总关系与失效项。
- [x] 链接解析严格限定在作用域内(越界目标视为失效,不泄漏其他项目)。
- [x] `src/links.ts` 有单测(解析、模糊解析、反链、失效)。

## 衡量指标

- 带互链的文档占比(知识网密度)。
- 通过"出链/入链"完成的跳转次数。

## 风险与依赖

- 反链索引需随写操作增量更新或随 `index` 重建,避免每次全扫。
- 模糊解析歧义(同名多篇)时给候选让用户选,不武断跳转。

## 与其他提案的关系(迭代递进)

- **复用已交付的 F02**(`src/match.ts`)做链接模糊解析、**F01**(`pageDoc`)做跳转。
- **增强 F07**:出链/入链成为 agent 上下文包的高质量相关信号。
- 与 **F13** 互补:F13 按内容相关性排序,F12 按显式引用关系连接。

## 实现记录

- done — 2026-06-18 实现并通过测试(159/159)。
  - `src/links.ts`(新增,纯函数):`extractLinks`(解析 `[[...]]`,去重保序)、`resolveLink`(精确 rel → 文件名 → 标题 → 复用 F02 `match.fuzzy` 模糊解析,**仅在传入的 docs 内解析,越界目标即失效**)、`outlinksOf`、`buildBacklinks`(反链索引,忽略自引)。
  - `src/core.ts`:`getLinks(vault, project, rel)` 读全项目正文,产出 `{outlinks, backlinks, broken}`;`generateIndex` 新增 `## 关系` 区块(逐文档出链)与 `## ⚠ 失效链接` 汇总。
  - `src/tui.tsx`:`/open` 阅读视图在分页器底部追加"出链 → / 被引用 ← / ⚠ 失效"页脚;新增 `/links <rel>` 进入可选中列表(复用 browse,Enter 跳转出链/入链文档)。
  - `src/commands.ts` / `src/cli.ts`:`/links` 与 `docky links <rel>`(打印出链/入链/失效)。
  - 作用域:解析只在 `listDocs(project)` 范围内,跨项目/越界目标自然解析为 null(失效),不泄漏其他项目。
  - 测试:`test/links.test.ts`(解析、四级解析、失效/越界、反链忽略自引、broken 标记)+ `test/core.test.ts`(getLinks 出/入/失效、INDEX 关系+失效区块)+ `test/tui.test.tsx`(`/links` 可跳转列表)。CLI 实测 `links` 与 INDEX 关系区块。
  - 备注:阅读视图以页脚列出链接(less 无法做"输入序号跳转"),跳转能力由 `/links` 可选中列表提供;F07 上下文包接入出/入链作为信号留待后续(非本轮验收项)。
