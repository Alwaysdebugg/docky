---
title: F14 · REPL 手感升级(参数补全 + 命令历史)
type: plan
owner: PM
status: done
priority: P1
effort: S
round: R3
created: 2026-06-17
completed: 2026-06-18
tags: [tui, 效率, repl]
---

# F14 · REPL 手感升级(参数补全 + 命令历史)

> 一句话:Tab 不只补命令名,还能**补参数**(文档路径 / 类型 / 项目名);并加上 shell 式**命令历史召回**,让 docky 的输入框像真正的终端。

## 背景与痛点

REPL 的补全与历史都只做了一半:

- `suggest()` **只补命令词**,一旦输入越过命令名(出现空格)就直接返回 `[]`(`src/commands.ts`)。于是 `/open <相对路径>`、`/use <项目>`、`/mv <rel> <类型>`、`/add <类型> …` 的**参数全靠手敲精确值**。
- 没有**命令历史**:`↑/↓` 在 REPL 里被命令菜单/选择器占用(`src/tui.tsx` `useInput`),无法回溯"我上一条敲的命令",重复操作得整条重打。
- 这与 F02(模糊打开文档)是不同面:F02 解决"打开哪篇",F14 解决"把任意命令的参数敲对、把敲过的命令找回来"。

## 目标 / 非目标

**目标**
- **参数级 Tab 补全**(上下文感知):
  - `/open|/mv|/rm <rel>` → 补当前作用域文档相对路径;
  - `/add|/mv|/list <类型>` → 补 `DOC_TYPES`;
  - `/use <项目>` → 补已注册项目名。
  - 用 F02 的 `match.ts` 做模糊候选。
- **命令历史**:菜单关闭时 `↑/↓` 召回历史命令;`Ctrl-R` 反向搜索;按项目/全局持久化。

**非目标**
- 不做多行编辑;不替代 F02 的文档快速打开(二者互补)。

## 用户故事

- 作为开发者,我敲 `/mv desi<Tab>` 直接补出 `design/架构.md`,再 `<Tab>` 补目标类型,免记路径。
- 作为重度用户,我按 `↑` 找回上次那条 `/search 鉴权 -t design`,回车重跑。

## 交互设计

```
› /open arch
   ▸ design/架构.md         (Tab 补全参数)
     design/旧架构.md
———
› (↑) /search 鉴权 -t design     ← 历史召回
```

## 技术落点

- `src/commands.ts`:把 `suggest()` 扩展为"解析已输入的命令 + 当前参数位",返回该位的候选(路径来自 `core.listDocs`、类型来自 `DOC_TYPES`、项目来自 `listProjects`),复用 `match.ts` 排序。
- `src/tui.tsx`:Tab 在参数位插入补全;REPL 模式且菜单关闭时 `↑/↓` 走历史;`Ctrl-R` 反搜。
- 历史持久化:vault 内 `.docky-history`(作用域安全),去重、上限。

## 验收标准

- [x] Tab 能按命令上下文补 路径/类型/项目名,且模糊匹配。
- [x] 菜单关闭时 `↑/↓` 召回历史;`Ctrl-R` 可反向搜索。
- [x] 历史跨会话持久化、去重、有上限。
- [x] 与既有命令菜单/选择器的 `↑/↓` 不冲突(仅在合适上下文接管)。
- [x] 补全与历史逻辑有单测(参考 `test/commands.test.ts`)。

## 衡量指标

- 命令平均键入字符数下降;因路径/类型敲错导致的报错率下降。
- 历史召回的使用频次。

## 风险与依赖

- `↑/↓` 语义需精确分流(菜单/选择器优先,空闲时才给历史),避免误触。
- 复用 F02 的 `match.ts`;补全候选量大时限制条数。

## 与其他提案的关系(迭代递进)

- **复用已交付 F02** 的 `src/match.ts`;与 F02 同属"降低输入摩擦"但面不同(参数/历史 vs 文档打开)。
- 让 **F05** 之后的新用户更快上手命令;让 **F11** 的整理流更顺(快速敲准路径/类型)。

## 实现记录

- done — 2026-06-18 实现并通过测试(172/172)。
  - `src/commands.ts`:新增 `suggestArgs(vault, project, input)`——按命令 + 当前参数位返回候选:`/open|/rm|/mv|/links|/pin|/log|/diff <rel>` 补作用域文档路径、`/add|/new|/list <类型>` 与 `/mv` 第2位补 `DOC_TYPES`、`/status` 第2位补 `DOC_STATUSES`、`/use` 补项目名;复用 F02 `match.fuzzy` 排序,上限 12;空格前(命令词)交还 `suggest()`。
  - `src/core.ts`:`loadHistory`/`pushHistory`(项目内 `.docky-history`,经 `safePath` 作用域安全、去重连续、上限 200、已 gitignore)。
  - `src/tui.tsx`:菜单关闭且在参数位时 Tab 弹出参数候选并补全(替换当前 token + 追加空格);命令菜单/参数菜单均无时 `↑/↓` 召回历史、`Ctrl-R` 反向搜索(含当前片段的更旧条目);打字即重置历史浏览;挂载时按当前项目载入历史、提交时持久化。
  - 分流:`↑/↓` 严格优先级为 命令菜单 → 参数菜单 → 历史,避免与既有选择器冲突;命令历史状态命名 `cmdHist` 以避开既有"输出历史" state。
  - 测试:`test/commands.test.ts`(suggestArgs 补路径/类型/状态/项目 + 命令词返回空;history 持久化/去重/封顶)+ `test/tui.test.tsx`(Tab 补全文档路径、`↑` 召回历史到 `[p] ›` 提示行)。
  - 备注:`Ctrl-R` 为轻量实现(按当前片段循环更旧匹配,非完整 incremental 反搜提示);历史按项目持久化,会话内切项目沿用内存历史。
