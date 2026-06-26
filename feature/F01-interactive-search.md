---
title: F01 · 交互式搜索结果(搜即跳转)
type: plan
owner: PM
status: done
priority: P0
effort: S
round: R1
created: 2026-06-17
completed: 2026-06-17
tags: [检索, tui, cli]
---

# F01 · 交互式搜索结果(搜即跳转)

> 一句话:让 `/search` 的命中项可以上下选中、回车直接在分页器里**跳到匹配行**,把"搜索"从只读清单变成可操作的入口。

## 背景与痛点

当前搜索结果是**死文本**,无法操作:

- TUI 里 `/search` 把命中逐行 `push(line(...))` 打印就结束(`src/commands.ts`),用户拿到一串 `design/x.md:42 片段…` 后,还得**手动把相对路径复制**到 `/open` 才能看正文。
- 对比 `/list`:它会进入交互式浏览模式(`src/tui.tsx` 的 `enterBrowse`、`mode === "browse"`),可 ↑/↓ 选中、Enter 预览。搜索却没有这层交互,体验割裂。
- 关键信息被浪费:`core.searchDocs` 返回的命中里**已经带了 `rel`、`line`、`snippet`、`project`**(见 `commands.ts` 对 `h.line` 的使用),但我们既没用它做跳转,也没让它可点选。
- CLI 端 `docky search` 同样只是打印 `rel:line snippet`,无法从命中直接打开。

> 结论:检索链路在"找到"和"打开"之间断了一刀,而所需数据其实已经齐备,补齐成本低、收益高。

## 目标 / 非目标

**目标**
- 搜索结果成为一等交互列表:↑/↓ 选中、Enter 在**同终端分页器**打开并定位到匹配行、`e` 用编辑器在该行打开、Esc/q 返回。
- 命中按 `类型/` 分组展示(复用 `/list` 浏览器的分组渲染),并显示 `rel:line` 与高亮片段。
- 支持沿用 `-t 类型` 过滤(`/search <kw>` 与未来 `/search -t debug <kw>`)。

**非目标**
- 不在本提案做语义/embedding 检索(属路线图后续轮次)。
- 不改变 `core.searchDocs` 的匹配算法(仅消费其结果)。

## 用户故事

- 作为开发者,我搜 `session`,想**直接回车看到正文里那一行**,而不是再去敲一遍路径。
- 作为开发者,我搜到一个想改的片段,想**按 `e` 直接在编辑器里跳到该行**修改。

## 交互设计

复用现有浏览器骨架,新增一个 `mode === "results"`:

```
search: session                                  (12 命中)
design/
  ▸ 架构.md:42        …创建 session 时写入缓存…
    架构.md:88        …session 过期策略…
debug/
    登录排查.md:13     …session 丢失导致 302…
↑/↓ 选择 · Enter 跳到匹配行 · e 编辑器打开 · Esc/q 返回
```

- **Enter**:`pageDoc(project, rel)` 增强为可接受起始行 → 分页器跳转(`less +<line>` / `$PAGER`,见 `src/pager.ts`)。
- **e**:`openExternally(path, line)`,对支持的编辑器传 `+<line>`/`:line`。
- 顶部回显查询与命中数;空结果显示友好提示。

## 技术落点

- `src/tui.tsx`:新增 `results` 模式与导航(可与 `browse` 共用一套行渲染逻辑,抽出 `selectableList`)。
- `src/pager.ts`:`spawnPager(rendered, startLine?)`、`openExternally(path, line?)`。
- `src/commands.ts`:TUI 路径下 `/search` 改为进入 `results` 模式(类似现有 `list`/`open` 的特判);CLI 保持打印,另加 `--open` 走简易选择器(可选)。
- 复用 `core.searchDocs` 既有返回结构,无需改 core 数据模型。

## 验收标准

- [x] `/search kw` 进入可选中的结果列表,而非静态文本。
- [x] Enter 打开对应文档并**定位到匹配行**(分页器停在该行附近)。
- [x] `e` 用外部编辑器在匹配行打开。
- [x] 结果按类型分组,显示 `rel:line` 与片段;空结果有提示。
- [x] Esc/q 返回 REPL,作用域隔离不被绕过(越界路径仍被 `safePath` 拒绝)。
- [x] 新增/更新单测覆盖结果模式的进入与选中(参考 `test/tui.test.tsx`)。

## 衡量指标

- "搜索 → 打开"平均按键数:目标从"复制路径 + `/open`"(≥5 次操作)降到 **≤2 键**。
- 搜索后 30s 内发生一次 open 的比例(检索有效转化)。

## 风险与依赖

- 分页器跳转依赖 `$PAGER` 支持 `+<line>`(`less` 支持;非 less 时降级为从头打开)。
- 与 F02 复用同一套"可选中列表"组件,建议先抽出公共组件再并行开发。

## 与其他提案的关系

- 与 **F02(快速打开)** 共用列表/命中数据与可选中列表组件。
- 为 **F03(标签/生命周期)** 提供天然的结果过滤入口(按 `status`/`tag` 收窄命中)。

## 实现记录

- done — 2026-06-17 实现并通过测试(70/70)。
  - `src/tui.tsx`:新增 `mode === "results"`,`/search` 进入可上下选中的命中列表;Enter 用 `pageDoc(proj, rel, line)` 打开**原始正文**并经 `less +<line>` 定位到匹配行;`e` 调用 `openExternally(path, line)` 在外部编辑器对应行打开;Esc/q 返回 REPL;命中按类型分组,显示 `name:line` 与片段,空结果回退到友好提示并留在 REPL。
  - `src/pager.ts`:`spawnPager(rendered, startLine?)` 对 `less`/`more` 追加 `+<line>` 跳转;`openExternally(filePath, line?)` 支持 VS Code/Sublime 系编辑器的行号定位,其余退回系统默认打开。
  - `src/commands.ts`:`/search` 文案更新为"可选中跳转"。
  - 作用域隔离不变:`e` 经 `core.safePath` 解析绝对路径,越界路径仍被拒。
  - 测试:`test/tui.test.tsx` 覆盖进入结果模式、↓ 选中、空结果提示。
