---
title: F17 · 导出与分享
type: plan
owner: PM
status: proposed
priority: P1
effort: M
round: R4
created: 2026-06-17
tags: [外延, 分享, 导出]
---

# F17 · 导出与分享

> 一句话:把项目文档**一键导出为自包含的 HTML / 静态站点 / 单篇**,让不用 docky 的同事也能读到这些过程文档,而不是复制粘贴。

## 背景与痛点

docky 的文档目前**只在 docky 内可读**:

- 阅读入口仅 TUI/CLI 的分页器(`renderMarkdown` + `spawnPager`,`src/pager.ts`)、MCP(给 agent),或直接看 raw md。
- 想把一篇设计稿/排查记录发给 PM、QA、外部协作方——他们没有 docky,只能**复制粘贴**,导致内容分叉、丢失上下文(尤其 F12 的互链全断)。
- 没有任何 `export`/`share` 能力(`COMMANDS`、`docky` 子命令里均无)。

## 目标 / 非目标

**目标**
- `docky export [-p 项目] [-t 类型] [--format html|site|md] [-o 输出目录]`:
  - `site`:生成自包含静态站点(项目 INDEX 首页 + 每篇一页),**F12 互链解析为站内锚点**,**F03 的 status/tags 渲染为徽标**。
  - `html`/`md`:单篇或选定集导出。
- `docky share <相对路径>`:输出**单文件 HTML**(内联样式,便于直接发送)。
- 导出内容严格限定在作用域内(或 F15 授权范围),反映已提交状态(F08)。

**非目标**
- 不内建托管/上传(产物交给用户自行分发)。
- 不做富交互站点(静态只读即可;搜索可后续)。

## 用户故事

- 作为开发者,我 `docky export --format site -o ./docs-site`,把项目文档导成静态站点发给团队。
- 作为协作者,我 `docky share design/架构.md` 得到一个 HTML,直接丢进邮件/IM。

## 交互设计

```
$ docky export --format site -o ./out
✓ 14 篇 → ./out (index.html + 14 页;互链已解析,徽标已渲染)
$ docky share design/架构.md
✓ ./架构.html (自包含,可直接发送)
```

## 技术落点

- 复用 F16 抽出的"渲染 + 大纲"模块,目标产物为 HTML(md→HTML 用 `marked`,已是依赖)。
- 新增 `src/export.ts`:站点生成(首页复用 `generateIndex` 数据)、单篇导出;解析 F12 链接为锚点;嵌入 F03 徽标。
- `src/cli.ts` / `src/commands.ts`:`export` / `share` 命令。

## 验收标准

- [ ] `export --format site` 生成可离线打开的静态站点(首页 + 每篇页)。
- [ ] F12 互链在站内解析为锚点;失效链接有标注。
- [ ] F03 的 status/tags 在导出中以徽标呈现。
- [ ] `share <rel>` 生成自包含单文件 HTML。
- [ ] 导出仅含作用域内(或 F15 授权)文档;`src/export.ts` 有单测。

## 衡量指标

- 因"对方没装 docky"而复制粘贴文档的行为减少。
- export/share 的使用频次。

## 风险与依赖

- 自包含 HTML 需内联 CSS/资源,注意体积。
- 依赖 F16(渲染模块)、F12(链接解析,缺席时退化为纯文本)、F03(徽标)。

## 与其他提案的关系(迭代递进)

- **复用 F16** 的渲染/大纲、**F12** 的互链、**F03** 的徽标、**F08** 的提交状态。
- 是 R4"外延"的代表:把 R1–R3 积累的结构化文档**带出 docky**。
