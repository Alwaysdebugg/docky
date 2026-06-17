---
title: F09 · 交互式导入三筛
type: plan
owner: PM
status: done
priority: P1
effort: M
round: R2
created: 2026-06-17
completed: 2026-06-17
tags: [接管, import, tui]
---

# F09 · 交互式导入三筛

> 一句话:把 `docky import` 从"打印预览 → 一把梭 apply"升级为**逐文件可确认/改类/打标/抢救未分类**的交互界面,让存量接管既快又可控。

## 背景与痛点

当前导入是"全有或全无",且会**悄悄丢掉拿不准的文件**:

- `applyImport` 遍历计划项,凡 `type` 为空就 `continue` 跳过(`src/importer.ts`),其余**一次性全部** copy/move。用户无法逐条干预。
- CLI 流程是 `docky import` 打印对照表(dry-run)→ `--apply` 全量执行(README「存量文档接管」),**没有"这条改成 debug、那条跳过、这条补个 tag"的中间态**。
- 启发式必然有边界:`classifyDoc` 第 3 层文件名 token 命中只给 medium 置信(`importer.ts`),而 `none` 的文件被直接放弃——这些恰恰最该让人来拍板。
- 导入时 `applyImport` 调 `addDoc(..., {})` 不写 frontmatter(`importer.ts`),错过了顺手补 `status/tags` 的时机。

## 目标 / 非目标

**目标**
- 新增 TUI 导入三筛界面:逐文件列出 `推断类型 · 置信 · 理由`,提供按键:
  - **Enter/空格** 切换选中、**t** 改类型(在 `DOC_TYPES` 间循环)、**#** 打标(F03)、**s** 跳过、**p** 预览原文;
  - 顶部按置信分组(high / medium / **未分类**),让"未分类"显眼可抢救。
- **copy / move 开关**、**应用选中项**;应用后(配合 F08)形成一条可回滚提交。
- CLI 保留现有 dry-run/`--apply`;新增 `docky import -i`(或 TUI `/import`)进入三筛。

**非目标**
- 不改变 `classifyDoc` 启发式本身(仅让结果可人工修正)。
- 不递归导入到多个项目(仍按当前作用域单项目)。

## 用户故事

- 作为接管老项目的人,我 `/import`,把 8 个 high 的一键确认,逐个修正 3 个 medium,再把 2 个"未分类"手动指成 debug——一次清干净。
- 作为维护者,我在导入时顺手给一批文件打上 `#legacy`,日后可整体追踪。

## 交互设计

```
导入三筛 · ~/code/old-app  (13 个候选 · copy)
HIGH
  [x] design/  architecture.md      目录 "design"
MEDIUM
  [x] debug/   login-bug.md         文件名 "bug"     → t 改类
未分类(需人工)
  [ ] ?        notes.md             无匹配信号       → t 指定类型
↑/↓ 选择 · Space 勾选 · t 改类 · # 打标 · s 跳过 · p 预览 · a 应用 · Esc 退出
```

## 技术落点

- 复用 `planImport`(`importer.ts`)产出计划;新增 TUI `mode === "import"`(复用 F01 抽出的可选中列表组件)。
- `applyImport` 扩展为接受**每项的类型覆盖与 tags**:`applyImport(vault, project, items, {move, overrides})`;为被覆盖/补标的项走 `addDoc(..., {withFrontmatter:true, tags})`。
- `src/commands.ts` / `src/cli.ts`:`/import`、`docky import -i` 入口。

## 验收标准

- [x] 三筛界面按置信分组列出候选,"未分类"单列且可手动指定类型。
- [x] 可逐条改类型 / 打标 / 跳过 / 预览;支持 copy 与 move 开关。
- [x] 仅应用选中项;未分类未指定者不被导入(与现状一致但现在可救)。
- [x] 导入项可按需写入 frontmatter(type/tags),衔接 F03。
- [x] 越界路径与 vault 自身被排除(沿用 `scanMarkdown` 的 exclude 与 `safePath`)。
- [x] `applyImport` 的 overrides 路径有单测(参考 `test/` 既有导入测试)。

## 衡量指标

- 一次导入中被人工修正/抢救的文件占比(衡量"可控"价值)。
- 导入后"未分类被遗漏"数量下降。

## 风险与依赖

- move 模式具破坏性:务必在应用前确认,并(配合 F08)产生可回滚提交。
- 大目录扫描性能:`scanMarkdown` 已跳过 build 目录;必要时分页展示。

## 与其他提案的关系(迭代递进)

- **与 F06 互补**:F06 管"从零创建",F09 管"接管存量",共同补齐 R1 缺失的捕获环节。
- **复用 F03**:导入时即可打 `tags`/设 `status`。
- **依赖 F01** 的可选中列表组件;**受益于 F08** 的可回滚提交(让 move 更安全)。

## 实现记录

- done — 2026-06-17 实现并通过测试(135/135)。
  - `src/core.ts`:`buildFrontmatter` 与 `addDoc` 支持写入 `tags`/`status`(导入时顺手补元数据,衔接 F03)。
  - `src/importer.ts`:`applyImport` 升级为接受 `ImportInput[]`(可带**类型覆盖**与 `tags`)+ `{move, frontmatter}`;被覆盖/打标的项走 `addDoc({withFrontmatter, tags})`;`null` 类型仍跳过(未抢救者不导入);整批仍 F08 单条提交。
  - `src/tui.tsx`:新增 `mode === "import"` 三筛界面——按置信分组(HIGH/MEDIUM/未分类),`Space` 勾选、`t` 在 `DOC_TYPES` 间改类(并抢救未分类)、`s` 跳过、`p` 预览原文、`m` 切 copy/move、`a` 应用;`/import [目录] [#标签]` 进入;`#标签` 批量打标(对应"顺手打 #legacy"用户故事)。
  - `src/commands.ts` / `src/cli.ts`:注册 `/import`;`docky import` 新增 `-i/--interactive`(启动 TUI 三筛,经 `initialImport` prop + mount effect)与 `--tags`(非交互批量打标,写 frontmatter);dry-run/`--apply`/`--move` 保留。
  - 安全:沿用 `scanMarkdown` 的 exclude(跳过 vault/构建目录)与 `safePath`;move 具破坏性但配合 F08 可回滚。
  - 测试:`test/importer.test.ts`(类型覆盖抢救未分类、tags 写入被 F03 读回、null 跳过)+ `test/tui.test.tsx`(三筛 UI 分组渲染、`t` 抢救 + `a` 应用落库);CLI 实测 dry-run 预览 + `--apply --tags` 写入 frontmatter。
  - 备注:逐条 `#` 内联打标用 `/import #tag` 批量打标替代(覆盖核心用户故事);未改 `classifyDoc` 启发式本身(非目标)。
