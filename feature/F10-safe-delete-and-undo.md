---
title: F10 · 安全删除与撤销
type: plan
owner: PM
status: done
priority: P1
effort: S
round: R2
created: 2026-06-17
completed: 2026-06-17
tags: [安全, 错误恢复, 数据安全]
---

# F10 · 安全删除与撤销

> 一句话:删除前先确认、删除入"回收站"、并提供 `docky undo` 一键回退上一次写操作;同时堵住"同名静默覆盖"的坑。

## 背景与痛点

破坏性操作目前**没有任何护栏**:

- `removeDoc` 是即时 `fs.unlinkSync`(`src/core.ts`);TUI `/rm` 与 CLI 删除**不二次确认**(`src/commands.ts`)。
- 结合 F08 揭示的"vault 从不 commit",**删掉一篇没提交过的文档 = 永久丢失**,git 也救不回。
- `addDoc`/`writeDoc` 用 `writeFileSync(dest)` **静默覆盖同名旧文件**(`core.ts`、`core.ts`):导入或重名归档可能悄悄盖掉已有内容。
- `moveDoc` 同理可覆盖目标(`core.ts`)。

> 一句话总结风险:**删除不可逆、覆盖无提示**。这是用户对工具"敢不敢放心用"的底线问题。

## 目标 / 非目标

**目标**
- **删除确认**:TUI `/rm` 与浏览器删除需确认(或 `--yes` 跳过);默认不裸删。
- **软删除回收站**:删除改为移入项目内 `.trash/`(带时间戳),而非直接 unlink;`docky trash` 查看,`docky restore <项>` 还原,超期或手动清空才真正删除。
- **一键撤销**:`docky undo` 回退**上一次写操作**(rm / mv / 覆盖式 add)。配合 F08 时用 `git revert`/`checkout`;F08 未上线时用回收站 + 操作日志兜底。
- **覆盖保护**:`add`/`write`/`mv` 目标已存在时提示并要求 `--force`(或在 TUI 里确认)。

**非目标**
- 不做多步 redo 栈(首版只回退最近一次)。
- 回收站不做跨项目共享(遵守作用域隔离,放项目内 `.trash/`)。

## 用户故事

- 作为开发者,我 `/rm` 时被要求确认,避免手滑;真删错了,`docky undo` 或 `docky restore` 立刻找回。
- 作为接管者,我归档一个同名文件时被提醒"已存在,是否覆盖",不再悄悄丢内容。

## 交互设计

```
/rm debug/登录排查.md
⚠ 确认删除 debug/登录排查.md? (移入 .trash,可 restore)  [y/N]

$ docky undo
✓ 已撤销:rm(debug/登录排查.md) —— 已从 .trash 还原

$ docky add design ./架构.md
⚠ design/架构.md 已存在。--force 覆盖,或换个 --name。
```

## 技术落点

- `src/core.ts`:`removeDoc` 改为移入 `safePath(vault, project, ".trash/<ts>-<name>")`;新增 `restoreDoc`、`listTrash`;`addDoc/writeDoc/moveDoc` 增 `force` 与 dest 存在检查。
- **操作日志**:vault 内 `.docky-oplog.json` 记录最近写操作(类型 + 路径 + trash 位置/旧 blob),供 `undo`。
- `src/commands.ts` / `src/cli.ts`:`/rm` 确认;新增 `undo` / `trash` / `restore`;`add/write/mv` 的 `--force`。
- 与 F08 协同:`autocommit=auto` 时优先用 git 实现 undo(更干净)。

## 验收标准

- [x] 删除默认进入项目内 `.trash/`,不即时物理删除;`restore` 可还原。
- [x] TUI/CLI 删除需确认,`--yes` 可跳过。
- [x] `docky undo` 能回退最近一次 rm / mv / 覆盖式 add。
- [x] `add/write/mv` 命中同名目标时不再静默覆盖,需 `--force` 或改名。
- [x] `.trash/` 与 oplog 均在作用域内,越界被 `safePath` 拒绝。
- [x] 新增单测覆盖删除→还原、覆盖保护、undo(参考 `test/core.test.ts`)。

## 衡量指标

- 误删后成功找回(undo/restore)的次数 / 占比。
- "静默覆盖"导致的内容丢失工单归零。

## 风险与依赖

- `.trash/` 需排除出 `listDocs`/`searchDocs`/INDEX,避免污染正常列表(以 `.` 前缀目录过滤)。
- 回收站清理策略(超期清除)需可配,避免无限增长。
- 与 F04 协同:删除/移动后同步清理"最近/置顶"中的失效项(F04 已含该验收点)。

## 与其他提案的关系(迭代递进)

- **依赖 F08**:有了自动提交,`undo` 可用 git 干净实现;二者共同根治 R2 暴露的数据安全隐患。
- **复用 F04**:删除联动清理最近/置顶。
- 是 R2"全生命周期"的收口:创建(F06)、接管(F09)、协作(F07)、留痕(F08)、**可逆兜底(F10)**。

## 实现记录

- done — 2026-06-17 实现并通过测试(144/144)。
  - `src/core.ts`:`removeDoc` 改为**软删除**——移入项目内 `.trash/<ts>__<URI编码rel>`,而非 unlink;新增 `listTrash`、`restoreDoc`、`undo`;每次写操作写 `.docky-oplog.json` 操作日志(rm/mv/overwrite,上限 50)。`addDoc` 增 `failIfExists`/`force`、`moveDoc` 增 `force`:目标已存在时默认拒绝(`已存在,--force 覆盖`),`force` 时把旧内容备份进 `.trash` 并记 overwrite 日志(可 undo)。`initVault` 的 `.gitignore` 追加 `**/.trash/`、`**/.docky-oplog.json`。
  - `undo` 兜底用回收站/oplog(不依赖 git,F08 在/不在都可用):rm→从 trash 还原、mv→移回原位、overwrite→恢复旧内容,并随后自动提交。
  - `src/commands.ts`:`/rm` 文案改"移入回收站";新增 `/undo`、`/trash`、`/restore`;`/add`、`/mv` 解析 `--force`(默认开启覆盖保护)。
  - `src/tui.tsx`:`/rm` 进入 `confirm` 模式二次确认([y/N],`--yes` 跳过);`doRm` 软删除并提示可 undo/restore。
  - `src/cli.ts`:`docky rm` 默认要求 `--yes`(确认门);新增 `undo`/`trash`/`restore`;`add`/`mv` 增 `--force`。
  - 作用域:`.trash/`、oplog 均经 `safePath` 在项目内,越界(如 `../../etc/passwd`)被拒;`.trash` 不是类型目录,天然不污染 `listDocs`/`search`/INDEX;删除联动 `forgetRel` 清理 F04 最近/置顶。
  - 测试:`test/core.test.ts`(软删→还原、undo rm/mv、覆盖保护+undo 恢复旧内容、mv 覆盖拒绝、越界拒绝、无操作可撤销)+ `test/tui.test.tsx`(`/rm` 确认 y 删除 / n 取消);CLI 实测 rm 门控→trash→undo、覆盖保护报错。
  - 备注:首版仅回退最近一次(无多步 redo,非目标);删除式 undo 用 trash+oplog 实现(比 git revert 更通用,F08 缺席也可用)。
