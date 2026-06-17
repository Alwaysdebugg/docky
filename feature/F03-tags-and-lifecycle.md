---
title: F03 · 文档标签与生命周期状态
type: plan
owner: PM
status: done
priority: P1
effort: M
round: R1
created: 2026-06-17
completed: 2026-06-17
tags: [组织, 维护, frontmatter]
---

# F03 · 文档标签与生命周期状态

> 一句话:在固定的 5 类之外,给文档加上**跨类型的 `tags`** 与 **生命周期 `status`**,并自动提醒**陈旧文档**,让文档库可被维护而不是只进不出。

## 背景与痛点

当前组织维度过于单薄,且没有"过期"概念:

- 文档只按 `项目 / 类型` 组织,类型是固定枚举 `design / plan / debug / code-review / prompts`(`src/types.ts` `DOC_TYPES`)。**没有跨类型聚合**:想看"所有关于登录的东西"无从下手。
- 项目已用 `gray-matter` 解析 frontmatter,且 `add -f` 会写入 frontmatter(`commands.ts`),但**只用到 `type`/`name`**,`status`、`tags` 等元数据完全没被消费。
- **没有生命周期**:一篇 `plan` 做完了、一篇 `design` 被推翻了,都没法标记;debug/design 文档随时间变陈旧,却没有任何提醒。文档库会逐渐"可信度衰减"。

## 目标 / 非目标

**目标**
- frontmatter 扩展并被一等消费:`status: draft | active | done | archived`、`tags: [..]`。
- 列表与检索支持新维度:`/list --status active`、`/list #登录`、`/search -#tag`;`archived` 默认隐藏。
- **生命周期操作**:`/status <相对路径> <状态>` 一键流转;`docky status` CLI 同义。
- **陈旧提醒**:`active` 的 `design/plan` 超过 N 天(默认 30,可配)未更新 → 在 `INDEX.md` 与 `/list --stale` 中标记 ⚠。

**非目标**
- 不引入自由分类目录(类型枚举保持稳定,tags 承担灵活维度)。
- 不做自动归档(仅提醒;是否 archive 由人决定)。

## 用户故事

- 作为开发者,我把三篇跨类型文档都打上 `#登录`,一条命令就能聚齐全部上下文。
- 作为维护者,我每周看一次 `/list --stale`,把过期设计标 `archived`,保持库的可信度。
- 作为 agent(经 MCP),`list_docs` 能据 `status` 优先返回 `active` 文档,少读到过时内容。

## 交互设计

```
/list --status active #登录
design/
  active   登录鉴权改造        #登录 #安全        (3d 前)
  ⚠ active 旧版登录流程        #登录              (61d 前 · 可能陈旧)
plan/
  done     登录灰度计划        #登录              (已完成)
```

- 列表行新增徽标:`status` 着色(active 绿 / draft 灰 / done 蓝 / archived 暗)、`tags`、相对更新时间;陈旧加 ⚠。
- `/status design/旧版登录流程.md archived` → 改写该文件 frontmatter 的 `status`。

## 技术落点

- `src/types.ts`:`DocInfo` 增加 `status?`、`tags?`、`mtime`。
- `src/core.ts`:`listDocs`/`searchDocs` 解析 frontmatter 填充 status/tags;新增 `setStatus`;陈旧判定(`mtime` + 阈值)。
- `src/config.ts`:可配 `staleDays`(默认 30)。
- `src/commands.ts`:`/list` 增 `--status`/`#tag`/`--stale` 解析;新增 `/status`。
- `INDEX.md` 生成(`core.generateIndex`)纳入 status/tags 与 ⚠ 陈旧标记。
- MCP `list_docs` 增加可选 `status`/`tag` 过滤(`src/mcp.ts`)。

## 验收标准

- [x] 文档 frontmatter 的 `status`/`tags` 被 `list`/`search`/`index` 解析并展示。
- [x] `/list --status active`、`/list #tag`、`/list --stale` 均生效;`archived` 默认隐藏。
- [x] `/status <rel> <state>` 正确改写 frontmatter,且受作用域隔离保护。
- [x] 超阈值的 active design/plan 在 INDEX 与 `--stale` 中带 ⚠。
- [x] MCP `list_docs` 支持按 status/tag 过滤,默认不返回 archived。
- [x] 新增单测覆盖 frontmatter 解析、过滤、陈旧判定(参考 `test/core.test.ts`)。

## 衡量指标

- 带 `tags`/非 draft `status` 的文档占比(组织度)。
- `archived`/`done` 文档占比随时间上升(维护在发生,而非只增不减)。
- `/list --stale` 命中数下降趋势(陈旧被及时处理)。

## 风险与依赖

- 历史文档无 frontmatter:解析需容错,缺省 `status=active`、`tags=[]`,不报错。
- 写 `status` 会改动文件内容,需保证幂等、保留正文(`gray-matter` stringify 注意保序)。
- 与 `docky import` 的归类启发式协同:导入时可顺带写入推断 tags(后续)。

## 与其他提案的关系

- 为 **F01/F02/F04** 增加 `status`/`tag` 过滤维度(搜索结果、快速打开、最近列表均可按标签收窄)。
- 陈旧提醒可作为 **F04 主页** 的一个区块("⚠ 待清理")。

## 实现记录

- done — 2026-06-17 实现并通过测试(98/98)。
  - `src/types.ts`:新增 `DOC_STATUSES`(draft/active/done/archived);`DocInfo` 增 `status` / `tags` / `mtime` / `stale`;`Config` 增 `staleDays`。
  - `src/config.ts`:`staleDays` 默认 30(`DEFAULT_STALE_DAYS`),向后兼容旧 config(缺省即 30)。
  - `src/core.ts`:`listDocs` 单次读文件解析 frontmatter 填充 status/tags(容错:缺省 `active` / `[]`,无 frontmatter 不报错),并据 `mtime + staleDays` 计算 `stale`(仅 active 的 design/plan);新增纯函数 `filterDocs`(按 status/tag/stale 过滤,**archived 默认隐藏**)、`setStatus`(用 `gray-matter` 改写 frontmatter、保留正文、幂等);`searchDocs` 默认经 `filterDocs` 隐藏 archived;`generateIndex` 渲染 `[status]` 徽标、`#tag`、`⚠` 陈旧标记并隐藏 archived。
  - `src/commands.ts`:导出 `parseListArgs`(共享解析 `[类型] --status #标签 --stale`)与 `formatDocLine`;`/list` 支持过滤与徽标渲染;新增 `/status <rel> <state>`。
  - `src/tui.tsx`:`/list` 经 `enterBrowse(args)` 套用过滤;browse 行展示 `⚠`/`[status]`/`#tags`。
  - `src/cli.ts`:`docky list` 增 `--status/--tag/--stale/--archived`;新增 `docky status <rel> <state>`。
  - `src/mcp.ts`:`list_docs` 增可选 `status`/`tag` 过滤,默认不返回 archived,输出附带 status/tags/stale。
  - 测试:`test/core.test.ts`(frontmatter 解析、filterDocs、陈旧判定、setStatus 保正文/拒非法+越界、search 隐藏 archived、index 徽标)+ `test/commands.test.ts`(parseListArgs、/status、/list 过滤与隐藏 archived)+ `test/tui.test.tsx`(过滤浏览器+徽标);CLI 实测 list/status/--archived 流程正确。
  - 备注:陈旧阈值用文件 `mtime`(非 frontmatter 时间戳),`setStatus` 会刷新 mtime;`/search -#tag` 的 tag 过滤已在 core 支持(`searchDocs` 接受 filter),CLI/TUI 入口后续可按需补简写。
