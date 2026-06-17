---
title: F08 · Vault 版本化与演进历史
type: plan
owner: PM
status: done
priority: P0
effort: M
round: R2
created: 2026-06-17
completed: 2026-06-17
tags: [可信, 留痕, git, 数据安全]
---

# F08 · Vault 版本化与演进历史

> 一句话:让 vault 的 git 真正"动起来"——每次写操作**自动提交**,并能**按文档查看演进与 diff**;顺带消除"未提交即丢失"的数据安全隐患。

## 背景与痛点(含一处数据安全隐患)

vault 是个**只 init、从不 commit** 的 git 仓库:

- `initVault` 执行 `git init -q` 并写空 `.gitignore`(`src/core.ts`),但此后 `addDoc / writeDoc / moveDoc / removeDoc / applyImport` **没有任何一处提交**(全仓库 grep 无 `commit`)。git 仓库形同摆设。
- 直接后果(数据安全):`removeDoc` 是即时 `fs.unlinkSync`(`core.ts`),而被删文档若从未提交,则 **git 也救不回来,永久丢失**。`addDoc` 用 `writeFileSync(dest)` 还会**静默覆盖同名旧文件**(`core.ts`)。
- 体验缺失:一篇长期演进的设计稿,**看不到它怎么变过来的**——没有 `log`/`diff`/时间线。

> 这是 R2 的"地基"提案:把版本化补上,既改善体验(演进可见),又堵住数据安全口子(为 F10 的撤销提供 git 基础)。

## 目标 / 非目标

**目标**
- **自动版本化**:每个写操作后自动 `git add -A && git commit`,提交信息语义化(如 `add(design): 鉴权改造`、`rm(debug): 登录排查`)。模式可配:`auto`(默认)/`manual`/`off`。
- **同步命令**:`docky sync`——提交所有未提交改动,并可选 `--push`(配置了 remote 时)。
- **演进历史**:`docky log <相对路径>` 列出该文档提交;TUI 浏览器里按 `h` 看时间线;`docky diff <相对路径> [revA] [revB]` 在分页器渲染 diff。
- **同步状态**:CLI/TUI 展示"N 处未提交",供 F04 主页与状态栏使用。

**非目标**
- 不内建远程托管/鉴权(push 交给用户既有 git 配置)。
- 不做分支/合并工作流(vault 是单线历史即可)。

## 用户故事

- 作为开发者,我想知道这篇设计稿**半年里改了什么**,`docky log design/架构.md` + `diff` 一目了然。
- 作为用户,我误删了一篇文档,因为有自动提交,F10 能把它**找回来**。
- 作为团队,我 `docky sync --push` 把当天的过程文档备份到远端。

## 交互设计

```
$ docky sync
✓ 已提交 4 处改动 (add×2, rm×1, mv×1)

$ docky log design/架构.md
  a1b2c3  2026-06-17  add(design): 架构
  d4e5f6  2026-06-12  edit(design): 增加缓存层
$ docky diff design/架构.md a1b2c3
  (分页器中渲染彩色 diff)
```

## 技术落点

- `src/core.ts`:已有底层 `git(cwd,args)`(`core.ts`)。新增 `commitVault(vault, message)`、`logDoc`、`diffDoc`;在 add/write/mv/rm/import 末尾按配置调用 `commitVault`。
- `src/config.ts`:新增 `autocommit: "auto"|"manual"|"off"`(默认 auto)。
- `src/commands.ts` / `src/cli.ts`:新增 `sync` / `log` / `diff`;TUI 浏览器 `h` 进入历史时间线。
- `src/pager.ts`:复用渲染 + 分页查看 diff。

## 验收标准

- [x] 默认 `auto` 下,add/write/mv/rm/import 后 vault 自动产生一条语义化提交。
- [x] `docky sync` 提交未提交改动;`--push` 在配 remote 时推送。
- [x] `docky log <rel>` / `docky diff <rel>` 正确显示该文档历史与差异。
- [x] `autocommit: off` 时行为回退到当前(不提交),不破坏既有单测。
- [x] 同步状态(未提交计数)可被查询。
- [x] 新增单测覆盖 commit/log/diff(在临时 git 仓库内)。

## 衡量指标

- vault "未提交改动"长期为 0 的会话占比(版本化在生效)。
- 通过 `log`/`diff` 查看演进的使用频次。

## 风险与依赖

- 性能:频繁小提交可接受;可按需做防抖(短时间多次写合并为一次提交)。
- 大仓库 diff 渲染走分页器,避免阻塞 TUI(沿用 F01 的 suspend-Ink 模式)。
- 需处理无 git / git 不可用的降级(`git()` 已 try/catch 返回 null)。

## 与其他提案的关系(迭代递进)

- **R2 的地基**:为 **F10(安全删除与撤销)** 提供 `git revert` 式撤销基础。
- 为 **F04 主页** 贡献"同步状态/未提交"区块。
- 与 **F09 导入** 协同:批量导入后自动形成一条可回滚的提交。

## 实现记录

- done — 2026-06-17 实现并通过测试(130/130)。
  - `src/types.ts` + `src/config.ts`:`Config.autocommit: "auto"|"manual"|"off"`(默认 auto,向后兼容旧 config)。
  - `src/core.ts`:复用底层 `git()` 新增 `commitVault`(内联 identity,无 git 配置也能提交)、`autoCommitVault`(仅 auto 模式)、`uncommittedCount`、`logDoc`、`diffDoc`、`syncVault(push?)`;在 `addDoc/writeDoc/moveDoc/removeDoc/setStatus` 末尾按配置自动提交,提交信息语义化(`add(design): x.md`/`rm: …`/`mv: …`/`status(…): active`)。`initVault` 的 `.gitignore` 改为忽略 `**/.docky-state.json`(避免 recents/pins 噪声入库)。
  - `src/importer.ts`:`applyImport` 用 `addDoc({noCommit:true})` 抑制逐条提交,末尾 `autoCommitVault` 形成**单条** `import: N 篇文档` 提交(可整体回滚,接 F09/F10)。
  - `src/pager.ts`:`pageRaw` + `colorizeDiff`(±/@@ 着色)。
  - `src/commands.ts` + `src/cli.ts`:`/sync`、`/log <rel>`、`/diff <rel> [revA] [revB]` 与 `docky sync [--push]` / `log` / `diff`;TUI 浏览器新增 `h` 看选中文档时间线。
  - 数据安全:删除现在先被自动提交,**history 在删除后仍可取回**(为 F10 撤销奠基);非 git vault / `autocommit: off` 优雅降级,既有单测全过。
  - 测试:`test/core.test.ts`(自动提交+历史、diff 对比旧版本、off 不提交而 sync 提交、rm 留痕、import 单条提交、非 git 降级);CLI 实测 auto-commit→0 未提交、`sync`、语义化 `log`。
