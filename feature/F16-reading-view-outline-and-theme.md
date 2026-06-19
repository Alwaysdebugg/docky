---
title: F16 · 阅读视图增强(大纲跳转 + 渲染主题)
type: plan
owner: PM
status: done
priority: P1
effort: M
round: R4
created: 2026-06-17
completed: 2026-06-18
tags: [阅读, tui, 渲染]
---

# F16 · 阅读视图增强(大纲跳转 + 渲染主题)

> 一句话:给"读文档"这件事配上**大纲(TOC)导航**——按标题一跳即到——并让渲染**宽度/主题可配**,长文档不再靠盲滚。

## 背景与痛点

R1 让"打开"变顺了,但"读长文"仍原始:

- 阅读走 `renderMarkdown(content)` + `spawnPager`(`src/pager.ts`);F01 加了 `+<line>` 跳转,但**只能跳到搜索命中行**,没有"看一眼结构、跳到某个标题"的能力。
- 一篇几百行的设计稿,想直达"## 风险与取舍"只能在分页器里手动搜。
- 渲染**宽度/主题不可配**:窄/宽终端、明/暗配色都用同一套 marked-terminal 默认。

## 目标 / 非目标

**目标**
- **大纲导航**:为当前文档抽取标题树(`#`/`##`/`###`),在阅读时按 `o` 弹出大纲;↑/↓ 选标题、Enter 跳到该标题行(复用 F01 的 `pageDoc` 行跳转)。
- `docky open` 顶部可选打印精简 TOC(`--toc`)。
- **渲染偏好**:宽度、主题(明/暗/无色)可配(经 F18),代码块/表格渲染更稳。
- 抽出统一的"渲染 + 大纲"模块,供 F17 导出复用。

**非目标**
- 不在终端做图形化(Mermaid 等先降级为带标注的代码块,真渲染留待 F17 的 HTML 导出)。
- 不改文档存储格式。

## 用户故事

- 作为开发者,我打开长设计稿,按 `o` 看大纲,直接跳到"验收标准"。
- 作为窄屏用户,我把渲染宽度设成 100,阅读不再错行。

## 交互设计

```
# 阅读 design/架构.md,按 o 唤出大纲
大纲
  ▸ # 架构
      ## 背景
      ## 方案
      ## 风险与取舍      → Enter 跳到第 88 行
↑/↓ 选择 · Enter 跳转 · Esc 返回正文
```

## 技术落点

- 新增 `src/outline.ts`:`extractHeadings(md) → [{level,title,line}]`(纯函数,可单测)。
- `src/pager.ts` / `src/tui.tsx`:阅读流程支持 `o` 唤出大纲选择器(复用 F01/results 的选择交互、`pageDoc(proj,rel,line)` 跳转)。
- `src/pager.ts`:`renderMarkdown` 接受宽度/主题选项(默认值来自 F18 配置)。

## 验收标准

- [x] 阅读时 `o` 唤出大纲,Enter 跳到对应标题行。
- [x] `docky open --toc` 顶部打印目录。
- [x] 渲染宽度/主题可配并生效(无配置时与当前默认一致)。
- [x] `src/outline.ts` 标题抽取有单测(含代码块内 `#` 不误判)。
- [x] 作用域隔离不变(仍经 `core.readDoc`/`safePath`)。

## 衡量指标

- 长文档(>150 行)阅读时"跳转到目标小节"的耗时下降。
- `--toc`/大纲的使用频次。

## 风险与依赖

- 需正确忽略代码块内的 `#`(避免误当标题)。
- 主题/宽度配置依赖 F18;F18 未上线时用内置默认。

## 与其他提案的关系(迭代递进)

- **复用已交付 F01** 的 `pageDoc` 行跳转与选择交互。
- **为 F17 导出**提供共享的"渲染 + 大纲"模块。
- 渲染偏好由 **F18 配置**统一管理。

## 实现记录

- done — 2026-06-18 实现并通过测试(187/187)。
  - `src/outline.ts`(新增,纯函数):`extractHeadings(md) → [{level,title,line}]`(ATX `#`…`######`,**跳过 ``` / ~~~ 围栏代码块内的 `#`**,容忍行尾 `#`)+ `renderToc`(按相对层级缩进)。供 TUI/`--toc`/F17 复用。
  - `src/types.ts` + `src/config.ts`:`Config.render { width?, theme: "dark"|"none" }`(默认 dark;为 F18 预留,无配置时与现状一致)。
  - `src/pager.ts`:`renderMarkdown(src, { width?, theme? })`——`width` 经 marked-terminal reflow,`theme:"none"` 去除 ANSI 颜色;默认路径行为不变。
  - `src/core.ts`:`renderPrefs(vault)` 读取配置渲染偏好。
  - `src/tui.tsx`:新增 `mode === "outline"`——browse 中按 `o`(或 `/outline <rel>`)弹出大纲选择器,↑/↓ 选标题、Enter 复用 `pageDoc(proj, rel, line)` 跳到该标题行;阅读分页统一套用 `renderPrefs`。
  - `src/cli.ts`:`docky open` 增 `--toc`(顶部目录)、`--width`、`--theme`。
  - 作用域不变:大纲与阅读仍经 `core.readDoc`/`safePath`。
  - 测试:`test/outline.test.ts`(标题抽取 + 行号、**围栏代码块内 `#` 不误判**、`~~~` 与行尾 `#`、renderToc 缩进、空大纲)+ `test/pager.test.ts`(theme none 去色、width 不抛)+ `test/tui.test.tsx`(`/outline` 弹大纲含行号)。CLI 实测 `open --toc --theme none`。
  - 备注:大纲为独立 TUI 选择器(less 持有终端,无法在分页器内唤起),与 PM mock 的"读时按 o"等价由 browse 的 `o` 实现;Mermaid 等图形化留待 F17 HTML 导出(非目标)。
