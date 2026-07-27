---
title: docky-lite 收敛切割规格(Cut Spec)
owner: PM
status: proposal
updated: 2026-07-27
---

# docky-lite · 收敛切割规格

> 背景:`00-capability-map.md` 已下结论——**停止铺新功能,差异化只在四块:检索 · agent 上下文/记忆 · 作用域隔离 · MCP 接入**。本规格把该结论**操作化**:2026-07-27 经一轮 grilling,选定**激进档「瘦到本质」**,明确到"删哪些模块/符号"。**本规格只描述决策,不含代码改动**——落地待批。

## 一、决策日志(grilling 2026-07-27)

| # | 决策 | 结论 |
|---|---|---|
| Q1 | 移除目标 | **产品聚焦**:判据=是否服务四大核心 |
| Q2 | 力度门槛 | **激进 · 瘦到本质**:非核心即砍 |
| Q3 | 界面本质 | **只留 CLI + MCP**,整块砍 Ink TUI |
| Q4 | F08 git 版本化 | **留基建(autoCommit)、砍历史查看面(log/diff)** |
| Q5 | F10 安全删除 | **砍掉**(与 git 恢复重叠),删除靠 git |
| Q6 | F03 生命周期 | **留最小 status(archived 排除检索)、砍陈旧机制** |
| Q7 | 叶子破例保留 | **默认全砍**(import/recents/wikilinks/INDEX 未破例) |
| Q8 | 交付形态 | **先出本规格、不动代码** |

## 二、保留:docky-lite 的本质(★=四大核心)

| 领域 | 保留的模块 / 符号 |
|---|---|
| **界面** | `cli.ts`、`mcp.ts`(仅二者;TUI 全去) |
| **作用域隔离 ★** | `registerProject` `listProjects` `resolveProject` `inferRepoName`、`projectDir` `safePath` `validateType` `ensureProjectDirs`、`scopedProject` `branchSegment` `branchScopeEnabled` `migrateBranchScope`(F56)、`resolveScopes` `addGrant` `revokeGrant` `listGrants`(F15) |
| **检索 ★** | `searchDocs` `searchAcross`、`match.ts`(相关性/模糊) |
| **上下文记忆 ★** | `buildContext`(F07 / get_context) |
| **MCP ★** | `mcp.ts` 六工具、`mcpresources.ts`(resources + prompts)、`hooks.ts`(setup/guard/context + install/uninstall) |
| **最小 CRUD** | `addDoc` `writeDoc` `smartWrite`(F20)、`scaffold` `renderScaffold` + `templates.ts`、`listDocs` `filterDocs`、`readDoc` + `pager.ts` 的 `renderMarkdown`/`pageRaw`、`removeDoc`(简化为 unlink+autoCommit)、`moveDoc`、`setStatus`(仅 draft/active/done/archived,archived 排除检索) |
| **信任基建** | `autoCommitVault` `commitVault` `initVault`(F08 基建)、`setup`/`uninstall`、`config.ts`(最小:vault/projects/grants/branchScope/types/render) |

## 三、移除清单

**整块界面层**
- `tui.tsx`、`commands.ts`、`test/tui.test.tsx`、`test/commands.test.ts`
- 依赖:`ink`、`react`、`@types/react`、`ink-text-input`、`ink-testing-library`
- 入口:`docky`(无参启 TUI)与 `docky ui` 取消 → 无参改打印 help;`import -i` 交互三筛消失

**按能力**

| 能力 | 移除符号 / 命令 |
|---|---|
| F10 安全删除 | `moveToTrash` `undo` `restoreDoc` `listTrash` `backupOverwrite` `logOp`(oplog);`rm`/`undo`/`trash`/`restore` 命令 → 仅留 `rm`(unlink + autoCommit) |
| F08 历史面 | `logDoc` `diffDoc`、`pager.colorizeDiff`;`log`/`diff` 命令(`sync` 留最小:提交/可选 push) |
| F03 陈旧 | `computeStale`、`staleDays`(config + CONFIG_KEYS)、`DocInfo.stale`、`--stale`、⚠ 标记 |
| F11 批量 | `batchMove` `batchSetStatus` `batchAddTags`(仅 TUI 多选用) |
| F23 图谱 | `graph.ts`、`graph.test.ts`、`graph` 命令 |
| F21 洞察 | `stats.ts`、`stats.test.ts`、`stats`/`dashboard` 命令 |
| F17 导出 | `export.ts`、`export.test.ts`、`export`/`share` 命令 |
| F24 智能文件夹 | `savedsearch.ts`、`savedsearch.test.ts`、`save`/`unsave`/`folders`/`open-folder` |
| F16 大纲 | `outline.ts`、`outline.test.ts`、`open --toc` |
| F19 体检 | `lint.ts`、`lint.test.ts`、`doctor`/`lint` 命令、`fixProject` |
| F22 审阅 | `inbox`/`review` 命令、`listPending`/`setReview`(写入侧 `stampFrontmatter` 可留作元数据或简化) |
| symlink | `linkProject` `unlinkProject`、`link`/`unlink` 命令 |

**Q7 默认(未破例,一并移除)**
- F09 导入:`importer.ts`、`importer.test.ts`、`import` 命令
- F04 最近/置顶:`getPins` `getRecents` `pin` `unpin` `recordOpen` `forgetRel`、recents state、`recent`/`pin`/`unpin`
- F12 互链:`links.ts`、`links.test.ts`、`getLinks`、`links` 命令(agent 仍可写 `[[..]]` 纯文本)
- INDEX:`generateIndex`、`index` 命令

## 四、执行前必处理的依赖 ripple(事实层)

- **`stats.ts` ↔ `links.ts` ↔ `lint.ts` 成串**:`computeStats` 依赖 `buildBacklinks`/`outlinksOf`(links)与 `lintProject`(lint)——三者同砍,方向一致,无残留引用。
- **`buildContext` 的 `metaScore`**:引用了 pins(F04)与 stale(F03),二者移除后需从打分中摘掉,保留 status/active 权重。
- **`generateIndex` 依赖 links**:INDEX 已砍则整函数移除;若日后想留 INDEX,须先与 `links.ts` 解耦(去掉反链段)。
- **MCP 工具描述**:`list_docs`/`get_context` 文案里"read INDEX"需改写(INDEX 已无)。
- **`filterDocs`**:保留 status/archived 过滤,移除 `stale` 分支;`parseListArgs` 随 commands.ts 一并去除,CLI `list` 自带 `--status`/`--archived` 保留、`--stale` 去除。
- **`config.ts`**:`CONFIG_KEYS` 移除 `staleDays`;`render`(width/theme)因 `open` 渲染而保留。
- **`core.ts` 不删、只瘦**:1794 行里剥离 F10/F03陈旧/F04/F12/INDEX/F11 相关符号,保留作用域/CRUD/检索/上下文/git。

## 五、建议执行顺序(待批后)

1. **删 TUI 层**(最大最独立):`tui.tsx` + `commands.ts` + 两测试 + 4 依赖;`cli.ts` 无参入口改 help。→ 单笔最大、几乎无 ripple。
2. **删叶子模块**:graph/stats/export/savedsearch/outline/lint + 各自命令与测试(互不依赖,可并行)。
3. **拆 core 内嵌能力**:F10 → F04 → F12/INDEX → F03陈旧 → F11;每步跑测试。
4. **收尾**:`config.ts`(去 staleDays)、MCP 描述文案、`package.json` 依赖裁剪、README 重写(三界面→两界面、删已移除功能)。

## 六、影响估算

- **src**:~7000 → 约 **2500–3000 行**(砍一半多);`core.ts` 显著变薄,`tui.tsx`/`commands.ts` 归零。
- **依赖**:减 3–5 个(ink 系 + react)。
- **命令面**:CLI 从 ~45 命令收缩到约 **15–18**(setup/uninstall/init/register/projects/whoami/add/new/list/open/status/mv/rm/search/grant/revoke/grants/config/hooks/migrate-branch-scope)。
- **MCP**:六工具 + resources + prompts **全保留**(核心接入面不动)。

## 七、待确认 / 开放项

- Q7 四项按"全砍"默认执行——若要保 `import`(上手既有仓库文档的唯一批量路径),现在说。
- `sync` 是否保留 push(团队远程)?lite 默认保"提交"、`--push` 可留可去。
- F22 写入侧 `source: agent / review: pending` 元数据戳:审阅流已砍,戳记留作纯元数据还是一并去除?(影响 `smartWrite`)

> 关联:`00-capability-map.md`(收敛总纲)。本规格是其"该收敛进 4–5 个核心能力"结论的可执行切割版。
