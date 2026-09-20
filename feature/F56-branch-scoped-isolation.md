---
title: F56 · 按分支强隔离(目录式)
type: design
owner: PM
status: done
priority: P1
effort: M
round: R12
created: 2026-06-23
completed: 2026-06-23
tags: [作用域, 隔离, mcp, 分支, 数据安全]
---

# F56 · 按分支强隔离(目录式)

> 一句话:让一个项目的过程文档**按所在 git 分支隔离**——agent 在分支 A 永远读不到分支 B 写的文档。当前落点为 `projects/<name>/branches/<branch>/<type>/`,项目根目录不再直接混放文档分类。

## 背景与痛点

docky 原本按**项目**隔离(`projects/<name>/` 由 `safePath` 硬隔离),但同一项目的不同分支**共享**同一文档库:

- 在 `feat/x` 分支让 agent 写的设计/排查文档,切到 `main` 或 `release/*` 后**仍可见**,跨分支串味。
- 分支是探测到的(`resolveProject` 返回 `branch`),但仅作为展示信息与可选 frontmatter,从不参与 list/search/read/context 的过滤。

对"一条分支一套思路"的工作流,这会让 agent 拿到**别的分支**的上下文,污染判断。

## 目标 / 非目标

**目标**
- 分支隔离始终开启,所有读写落到 `projects/<name>/branches/<branch>/<type>/`。
- `register` 只创建当前分支;切换后的新分支在首次写入时按需创建。
- 保留分支层级(`feat/ultra-update → branches/feat/ultra-update`);异常段安全净化并加稳定哈希防碰撞;detached/非 git → `_unbranched`。
- MCP 工具显式带 `branch` 入参(agent 从 `resolve_project` 拿到后回传);省略则落 `_unbranched`。
- `docky migrate-branch-scope` 同时迁移旧扁平布局和早期 F56 的单层分支桶。
- CLI / MCP / SessionStart 上下文全部按当前分支作用域。

**非目标**
- 不做跨分支的合并/diff(那是 git 的事;docky 只隔离存储)。
- 不改**项目级**授权(F15 grants 仍按项目;跨项目读默认取同名分支桶,缺失则无命中)。
- F25 资源 URI(`docky://<项目>/<类型>/<名>`)与一键 prompts 暂仍按裸项目,由已注册路径解析当前分支;后续可扩 URI scheme 显式携带分支。

## 设计要点 · 作用域键(scoped key)

核心抽象只有一个:**作用域键**。`scopedProject(vault, project, branch)` 始终返回 `"<name>/branches/<branch路径>"`。

所有文件系统操作本就以 `project` 作为 `projectDir`/`safePath` 的键,所以**把作用域键当作 `project` 传进去**即可让读/写/回收站/oplog/state/history 全部落进分支桶——core 内部几乎零改动。仅 `searchAcross`/`buildContext`(配置感知,需解析 grants)保留裸项目名 + 显式 `branch`,内部再算作用域键。

净化与防撞:`branchPath` 保留 `/` 层级并逐段净化;发生净化时追加稳定短哈希,避免不同分支映射到同一路径。独立的 `branches/` 命名空间让分支名不再与文档类型同级碰撞。

## 交互设计(工具契约)

```jsonc
// branch 即隔离键;branchScope:true 为旧客户端保留的兼容字段
{ "project": "proj", "branch": "feat/x", "matched": "/repo", "branchScope": true }

// 其余工具带可选 branch:省略 → _unbranched 桶
list_docs   { project, branch?, type?, status?, tag? }
read_doc    { project, branch?, path }
search_docs { project, branch?, query, type?, fuzzy?, across? }   // across 按裸项目解析授权
write_doc   { project, branch?, type, name, ... }
get_context { project, branch?, query?, budget?, across? }
```

## 用户故事

- 作为编码 agent,我在 `feat/x` 上 `write_doc`,只看得到 `feat/x` 的过程文档;切回 `main` 时 `list_docs` 干净如初。
- 作为维护者,我跑一次 `docky migrate-branch-scope`,存量文档归并进 `branches/main/` 桶,旧布局零丢失。

## 技术落点

- `src/config.ts`:移除 `branchScope` 开关,分支隔离成为唯一布局。
- `src/core.ts`:`BRANCHES_DIR`、`DEFAULT_BRANCH_BUCKET`、`branchPath`、`scopedProject`、`migrateBranchScope`;`registerProject` 创建当前分支分类目录。
- `src/mcp.ts`:5 个工具 + `resolve_project` 带 `branch`;`BRANCH_ARG` 复用 schema。
- `src/cli.ts`:`resolve()` 返回作用域键、`resolveBare()` 供 grant/revoke/link/across;新增 `migrate-branch-scope` 命令;`whoami` 显示隔离状态。
- `src/commands.ts`:`executeCommand` 内 `scopeOf()` 包裹文件系统命令;grant/revoke/link/unlink 保持裸名。
- `src/tui.tsx`:会话级固定 `branch`,`scoped()` 包裹所有文件系统 core 调用;配置/选择器/导入保持裸名。
- `src/hooks.ts`:SessionStart `contextText` 按当前分支列文档。

## 验收标准

- [x] 分支 A 写的文档在分支 B 不可见(list/read/search/context 全隔离),物理上分目录。
- [x] 项目根目录只显示 `branches/`,不直接显示六种文档分类。
- [x] `branchPath` 保留分支层级,异常字符净化且不发生静默碰撞。
- [x] `migrate-branch-scope` 把存量类型目录、状态目录和旧单层分支桶搬进新布局,幂等且不覆盖目标。
- [x] MCP 工具显式 `branch`,`resolve_project` 暴露兼容字段 `branchScope:true`;CLI/MCP/SessionStart 全链路作用域。

## 衡量指标

- 跨分支误读的过程文档数 → 0(开启后)。
- 成功迁入新目录布局的项目占比。

## 风险与依赖

- Git 不允许同时存在 `feat` 与 `feat/x` 引用;目录树继承这个约束。旧文档残留发生前缀冲突时由迁移命令保守跳过,不覆盖数据。
- 跨项目(F15)读取按同名分支桶,目标项目无此分支则无命中(优雅降级,文档化)。
- F25 资源/prompts 暂未带分支:开启时退化为空/裸,后续扩 URI scheme。

## 与其他提案的关系

- **F15 的正交补强**:F15 在项目间做受控*打通*,F56 在分支间做强*隔离*;二者都建立在 `safePath` 的作用域键之上。
- **复用 F20 的 agent 写入路径**:`write_doc → smartWrite` 接收作用域键即天然按分支去重/落盘。

## 实现记录

- update — 2026-09-19:分支目录成为唯一布局。新增 `branches/` 命名空间,`register` 创建当前分支,斜杠分支保留可读层级,首次写入懒创建后续分支;移除 `branchScope` 配置开关。迁移同时兼容项目根扁平分类和早期 F56 的 `feat-x/` 单层桶。当前回归测试 126/126 通过。

- 初版 done — 2026-06-23 实现并通过测试(248/248,新增 6 条 F56 用例;以下为当时的旧布局记录)。
  - 设计:作用域键 `scopedProject()` 为唯一抽象——边界(MCP/CLI/REPL/TUI)把 `"<name>/<branch>"` 当 `project` 传入,core 文件系统层零改动即落进分支桶;`searchAcross`/`buildContext` 保留裸项目名 + 显式 `branch`。
  - 迁移:`migrateBranchScope` 只搬**有内容**的类型目录(+ `.docky-*`/`.trash`/`INDEX.md`),清理 `ensureProjectDirs` 预建的空类型目录,`looksLikeBranchBucket` 防止把已迁移桶再次搬运;幂等。
  - 防撞:`branchSegment` 对净化后撞 `DOC_TYPES`/`_default` 的段加 `-branch` 后缀。
  - 端到端实测(CLI):`main` 建 alpha、切 `feat/x` 列表为空并建 beta、切回 `main` 仅见 alpha;落盘为 `projects/proj/main/design/alpha.md` 与 `projects/proj/feature-x/design/beta.md`。`migrate-branch-scope` 把裸布局 `design/plan` + `.docky-state.json` 归并入 `main/` 桶、空目录清理、裸层仅余桶。
  - 测试:`test/core.test.ts` 新增 describe "branch-scoped isolation (F56)"(branchSegment 净化/防撞、scopedProject 开关、A↛B 隔离、smartWrite/search/context 桶内、migrate 幂等、不吞已迁移桶)。
  - 已知限制:F25 资源/prompts 与跨项目同名分支假设见上「风险与依赖」。
