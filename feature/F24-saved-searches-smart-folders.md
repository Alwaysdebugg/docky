---
title: F24 · 保存的搜索与智能文件夹
type: plan
owner: PM
status: done
priority: P1
effort: S
round: R5
created: 2026-06-17
completed: 2026-06-18
tags: [检索, 效率, 持久化]
---

# F24 · 保存的搜索与智能文件夹

> 一句话:把常用的过滤/检索条件**存成命名的智能文件夹**(动态、实时求值),在主页、快速打开与列表里一键调出,不必每次重敲。

## 背景与痛点

R1/R3 的检索很强,但**条件是一次性的**:

- F03 已支持 `--status / #tag / --stale`、F13 升级了相关性检索,但每次都得**重新敲一遍**"`active #登录 design`"。
- F04 能**置顶具体文档**(静态集合),却无法**置顶一个查询**(动态集合)——而"所有待办草稿""所有登录相关"恰恰是随时间变化的动态集合。
- F14 的命令历史能回溯,但那是流水账,不是**精心命名、长期复用**的视图。

## 目标 / 非目标

**目标**
- `docky save <名称> <查询>`:把一条查询(类型 + `#标签` + `--status/--stale` + 关键词)存为智能文件夹;`docky folders` 列出;`docky open-folder <名称>` 或 `/f <名称>` 实时求值并以可选列表呈现(复用 F01)。
- 智能文件夹出现在 **F04 主页** 与 **F02 快速打开** 的候选里,一键进入。
- 实时求值:文件夹内容随库变化自动更新(它存的是**查询**,不是固定文件)。

**非目标**
- 不存储结果快照(始终动态求值);不引入新查询语法(复用 F03 的过滤 + F13 的检索)。

## 用户故事

- 作为开发者,我 `docky save 待办 "--status draft"`,以后 `/f 待办` 一键看所有草稿。
- 作为登录模块负责人,我把 `#登录 --status active` 存成"登录",钉在主页随时进入。

## 交互设计

```
$ docky save 待办 "--status draft"
✓ 智能文件夹「待办」= --status draft
$ docky folders
  待办     --status draft            (12 篇)
  登录     #登录 --status active     (8 篇)
# 主页 / 快速打开里:
📂 智能文件夹  待办(12) · 登录(8)
```

## 技术落点

- 持久化:存入配置(经 **F18** `docky config` 体系)或 vault 状态文件,结构 `{name, query}`。
- `src/savedsearch.ts`:解析已存查询 → 调用 F03 `filterDocs` / F13 `searchDocs` 求值。
- `src/commands.ts` / `src/cli.ts`:`save` / `folders` / `open-folder` 与 `/f`;接入 F04 主页与 F02 快速打开候选。

## 验收标准

- [x] 可保存/列出/删除命名智能文件夹;查询复用 F03/F13,不引入新语法。
- [x] 打开文件夹**实时求值**(随库变化更新),结果为可选列表(复用 F01)。
- [x] 智能文件夹出现在 F04 主页与 F02 快速打开候选中。
- [x] 跨会话持久化;作用域隔离不变;`src/savedsearch.ts` 有单测。

## 衡量指标

- 通过智能文件夹发起的检索占比;重复手敲相同查询的次数下降。
- 人均长期保留的智能文件夹数。

## 风险与依赖

- 存的是查询字符串,需对其做校验(非法查询给出提示)。
- 依赖 F03(filterDocs)/F13(search);持久化复用 F18(无 F18 时退回独立状态文件)。

## 与其他提案的关系(迭代递进)

- **把 F03/F13 的一次性检索固化为可复用视图**;与 **F04** 互补(静态置顶文档 vs 动态置顶查询)。
- 经 **F02 快速打开** 与 **F04 主页** 暴露;偏好持久化复用 **F18**。

## 实现记录

- done — 2026-06-18 实现并通过测试(231/231)。
  - `src/savedsearch.ts`(新增):每项目 `.docky-folders.json`(`{名称: 查询}`,经 `safePath` 作用域安全、已 gitignore)。`saveFolder`/`removeFolder`/`getFolder`/`listFolders`;`parseQuery`(把查询拆成 F03 过滤 `type/--status/#tag/--stale` + 余下 F13 关键词,**不引入新语法**);`evalFolder`(**实时求值**:有关键词走 `searchDocs`+filter,否则 `filterDocs`)。
  - `src/cli.ts`:`docky save <名> <查询...>`(用 `enablePositionalOptions`+`passThroughOptions`,使以 `--` 开头的查询可作为操作数;其余命令解析不受影响)、`unsave`、`folders`(列出 + 实时计数)、`open-folder <名>`(实时求值列出)。
  - `src/commands.ts`:`/save`、`/folders`;`src/tui.tsx`:`/f <名>` 实时求值进入 browse 可选列表;**F04 主页新增「📂 智能文件夹」行**(列出名称,提示 `/f`)。
  - 持久化跨会话;作用域隔离不变;空名/空查询被拒。
  - 测试:`test/savedsearch.test.ts`(增删查持久化、parseQuery 拆分、evalFolder 过滤/关键词、**实时随库变化**、空值拒绝)+ `test/tui.test.tsx`(主页显示文件夹 + `/f` 实时打开)。CLI 实测 save(`--` 开头查询)/folders 计数/open-folder 实时(加文档后计数+1)。
  - 备注:F02 快速打开的候选暴露以主页「📂 智能文件夹」+ `/f` 承载(未塞进模糊 doc 候选以免混淆文档与查询);持久化用独立状态文件(F18 已上线,后续可迁入 config 体系)。
