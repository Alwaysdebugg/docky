---
title: F06 · 文档模板与快速捕获
type: plan
owner: PM
status: done
priority: P1
effort: S
round: R2
created: 2026-06-17
completed: 2026-06-17
tags: [创建, 模板, tui, mcp]
---

# F06 · 文档模板与快速捕获

> 一句话:按文档类型套用**结构骨架模板**,用 `/new <类型> [名]` 一键起草,而不是面对一张空白页;模板同时为人和 agent 提供一致的写作脚手架。

## 背景与痛点

R1 把"找回文档"做顺了,但"**新建一篇文档**"仍然原始:

- `buildFrontmatter` 只写 `project / type / title / created / branch`(`src/core.ts`),**不含任何正文骨架**。
- `addDoc` 只是把 frontmatter 前置到已有文件(`core.ts`);`writeDoc` 直接写裸内容(`core.ts`)。**没有"新建空文档 + 模板"的入口**——CLI/TUI 也没有 `new` 命令(见 `COMMANDS`,`src/commands.ts`)。
- 结果:design / debug / code-review 等文档缺乏统一结构,质量与可检索性参差;agent 经 MCP `write_doc` 写入时也无范式可循。

## 目标 / 非目标

**目标**
- 每个类型自带可编辑模板(`design / plan / debug / code-review / prompts`),含标准小节骨架(如 debug:复现/期望/实际/影响/归因)。
- 新增 `/new <类型> [名]`:用模板创建文档并在编辑器/分页器打开;CLI `docky new <类型> [名]`。
- 模板默认带上 F03 的 `status: draft` 与 `tags: []` 占位,创建即进入生命周期。
- 模板存放于 vault(`templates/<类型>.md`),用户可改;缺失时回落到内置默认。
- MCP `write_doc` 可选 `scaffold: true`,让 agent 也能拿到同一套骨架。

**非目标**
- 不做富文本/可视化编辑(仍是 Markdown + 外部编辑器)。
- 不强制模板(可一键清空);不替代 `add`(导入既有文件)的路径。

## 用户故事

- 作为开发者,我敲 `/new debug 登录超时`,直接得到带"复现/期望/实际/影响/归因"骨架的草稿,填空即可。
- 作为团队,我把 `templates/design.md` 改成团队规范,之后所有人/agent 新建 design 都遵循它。

## 交互设计

```
/new design 鉴权改造
  → 由 templates/design.md 生成 design/鉴权改造.md(status: draft)
  → 在 $EDITOR 打开(无 TTY 时返回路径)

# 模板骨架示例(design)
---
type: design
status: draft
tags: []
---
# {{title}}
## 背景
## 目标 / 非目标
## 方案
## 风险与取舍
```

## 技术落点

- 新增 `src/templates.ts`:内置默认模板 + `loadTemplate(vault, type)`(优先 vault/templates,回落内置),`{{title}}`/`{{date}}` 占位替换。
- `src/core.ts`:`scaffold(vault, project, type, name)` = 模板渲染 + `writeDoc`;复用既有 `safePath`。
- `src/commands.ts`:注册 `/new`;`docky init` 时顺手在 vault 落地默认模板。
- `src/mcp.ts`:`write_doc` 增可选 `scaffold`。

## 验收标准

- [x] `/new <类型> [名]` 用对应模板创建文档,缺名时按标题/时间生成。
- [x] vault 内模板可被用户覆盖;缺失时回落内置默认。
- [x] 新建文档默认 `status: draft` + 空 `tags`(与 F03 衔接)。
- [x] MCP `write_doc({scaffold:true})` 返回带骨架的文档。
- [x] `src/templates.ts` 渲染逻辑有单测(占位替换、回落)。

## 衡量指标

- 新建文档中"含完整小节骨架"的占比。
- design/debug 文档的平均结构完整度(被 `search`/INDEX 命中率间接体现)。

## 风险与依赖

- 模板演进需向后兼容(占位符稳定)。
- 与 F03 协同:模板里的 `status/tags` 字段需被 F03 正确解析。

## 与其他提案的关系(迭代递进)

- **承接 R1 的 F03**:模板把 `status/tags` 作为默认元数据写入,让生命周期"从出生即生效"。
- **承接 F05**:新用户被引导进入作用域后,`/new` 是他/她的第一个"创造"动作。
- **与 F09 互补**:F06 解决"从零新建",F09 解决"接管存量",共同补齐 R1 缺失的"捕获"一环。

## 实现记录

- done — 2026-06-17 实现并通过测试(119/119)。
  - `src/templates.ts`(新增):5 类内置骨架模板(均带 `status: draft` + `tags: []`),`loadTemplate`(vault/templates/<类型>.md 覆盖 → 回落内置)、`renderTemplate`(`{{title}}`/`{{date}}` 替换、未知占位保留)、`writeDefaultTemplates`(init 时落地,不覆盖用户自定义)。
  - `src/core.ts`:`renderScaffold`(渲染模板)与 `scaffold`(渲染 + `writeDoc`,缺名时按 `<类型>-<日期>` 生成);`initVault` 顺手 `writeDefaultTemplates`。
  - `src/commands.ts`:注册 `/new <类型> [名]`;executeCommand 创建草稿并 `recordOpen`(接 F04)。
  - `src/tui.tsx`:`/new` 经 `newDoc()` 创建后用外部编辑器打开草稿、记录最近。
  - `src/cli.ts`:`docky new <type> [name]`。
  - `src/mcp.ts`:`write_doc` 增可选 `scaffold:true`(content 改为可选),让 agent 也拿到同一套骨架。
  - 与 F03 衔接:模板的 `status: draft` 被正确解析,`/list --status draft` 即见新建草稿。
  - 测试:`test/templates.test.ts`(占位替换、回落、覆盖、不clobber)+ `test/core.test.ts`(scaffold 草稿/默认名/非法类型/init 落地/用户覆盖)+ `test/commands.test.ts`(`/new` 草稿、缺类型报错);CLI 实测 init 落模板 + `new debug` 生成完整骨架 + draft 徽标。
