---
title: F04 · 最近访问与置顶
type: plan
owner: PM
status: done
priority: P1
effort: S
round: R1
created: 2026-06-17
completed: 2026-06-17
tags: [检索, tui, 持久化]
---

# F04 · 最近访问与置顶

> 一句话:记住你最近打开过、以及你钉住的文档,在 TUI 主页与"快速打开"里**优先呈现**,把高频的"再打开那一篇"变成一键。

## 背景与痛点

- 每次进入 TUI 都是**冷启动**:欢迎区只有 DOCKY 字标(`src/tui.tsx` `Banner` / `welcomeItems`),没有任何"你上次在看什么/常看什么"的线索。
- **没有任何 recency 记录**:`core.readDoc`/`/open` 打开文档后不留痕迹,最可能马上要再看的文档对用户不可见。
- 没有收藏/置顶:那 2–3 篇天天用的文档(如某长期演进的设计稿)每次都要重新找。

## 目标 / 非目标

**目标**
- 记录每个项目**最近打开**的文档(去重、保序、上限 N=10)。
- 支持**置顶**:`/pin <相对路径>` / `/unpin <相对路径>`,置顶持久化、跨会话保留。
- TUI 主页(欢迎区)分区展示「📌 置顶」「🕘 最近」;Enter 直达。
- 为 **F02 快速打开** 提供空查询默认候选与"最近"排序权重。
- CLI:`docky recent`、`docky pin/unpin`。

**非目标**
- 不做跨项目的全局最近(遵守作用域隔离;按项目维度记录)。
- 不做云同步(本地持久化即可)。

## 用户故事

- 作为开发者,我重启 docky,主页第一屏就能看到"最近"列表,Enter 直接续上工作。
- 作为重度用户,我把核心设计稿 `/pin`,它永远在主页第一位,随手可达。

## 交互设计

```
📌 置顶
  ▸ design/核心架构.md
🕘 最近
    debug/登录排查.md        (刚刚)
    plan/Q3 路线.md          (10 分钟前)
    design/核心架构.md       (1 小时前)
↑/↓ 选择 · Enter 打开 · /pin <路径> 置顶
```

- 进入即在 `repl` 模式上方渲染该项目的置顶+最近(可选中)。
- 打开任意文档(`pageDoc`/`/open`/F01 命中/F02 候选)时**记录一次访问**。

## 技术落点

- 持久化:在 vault 内 `projects/<项目>/.docky-state.json` 存 `{ recents: [...], pins: [...] }`(仍在项目作用域内,符合隔离;`safePath` 校验)。
- `src/core.ts`:`recordOpen(vault, project, rel)`、`getRecents`、`pin`/`unpin`/`getPins`;`addDoc`/`mv`/`rm` 时同步维护(删除/移动后清理失效项)。
- `src/tui.tsx`:打开类动作统一经过一个 `openDoc()` 包装以记录访问;主页渲染置顶/最近分区。
- `src/commands.ts`:新增 `/pin` `/unpin`;`COMMANDS` 与建议菜单登记。

## 验收标准

- [x] 打开文档后,该文档进入"最近"(去重置顶序、上限 N)。
- [x] `/pin`、`/unpin` 生效且**跨会话持久化**。
- [x] TUI 主页展示置顶+最近且可 Enter 直达。
- [x] 文档被 `mv`/`rm` 后,最近/置顶中的失效条目被清理。
- [x] 状态文件位于项目作用域内,越界访问被拒绝。
- [x] 新增单测覆盖 record/pin/清理逻辑(参考 `test/core.test.ts`)。

## 衡量指标

- 通过"最近/置顶"完成的 open 占总 open 的比例。
- 会话首个动作即来自主页推荐的比例(冷启动被有效缩短)。

## 风险与依赖

- 并发写状态文件需简单容错(读-改-写,损坏时重置而非崩溃)。
- 依赖一个统一的"打开"入口以埋点;建议与 F01/F02 同期把打开路径收敛为 `openDoc()`。

## 与其他提案的关系

- 直接为 **F02 快速打开** 提供默认候选与排序权重。
- 主页可并入 **F03** 的「⚠ 待清理(陈旧)」区块,形成完整"工作台首页"。

## 实现记录

- done — 2026-06-17 实现并通过测试(84/84)。
  - `src/core.ts`(持久化):`projects/<项目>/.docky-state.json` 存 `{ recents, pins }`,经 `safePath` 受作用域隔离;新增 `recordOpen` / `getRecents`(去重、保序、上限 N=10)、`pin` / `unpin` / `getPins`;读时 `pruneState` 清理已消失的文件;`removeDoc` / `moveDoc` 通过 `forgetRel` 清理失效项;损坏/缺失状态文件自动重置不崩溃;越界路径写入被拒(`pin` 抛错,`recordOpen` 静默忽略,绝不抛)。
  - `src/tui.tsx`:所有打开路径(`/open`、browse、F01 命中、F02 候选)统一经 `openDoc()` 埋点;主页 springboard 在空白 REPL 上方渲染「📌 置顶 / 🕘 最近」;新增 `/recent` 进入可选中列表(复用 browse,Enter 打开);F02 快速打开**空查询默认按 置顶+最近 排序**(补齐 F02 遗留项)。
  - `src/commands.ts` + `src/cli.ts`:新增 `/recent`、`/pin`、`/unpin`(TUI)与 `docky recent` / `pin` / `unpin`(CLI);`open` 命令同步 `recordOpen`。
  - 状态文件位于类型子目录之外,不会被 `listDocs` / `search` / `INDEX` 当作文档。
  - 测试:`test/core.test.ts`(record/cap/dedupe/persist、pin 幂等、rm+mv 清理、外部删除剪枝、作用域拒绝、不被列为文档)+ `test/tui.test.tsx`(主页置顶/最近、打开埋点、`/recent` 选择列表、空查询置顶优先);CLI 端实测 open→recent→pin→unpin 流程正确。
  - 备注:未做"相对时间(刚刚/10 分钟前)"展示(状态只存 rel,未存时间戳),如需可在后续轮次为 recents 增加时间元数据。
