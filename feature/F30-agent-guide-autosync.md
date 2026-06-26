---
title: F30 · Agent 指南自动维护(CLAUDE.md / AGENTS.md)
type: plan
owner: PM
status: proposed
priority: P1
effort: S
round: R6
created: 2026-06-17
tags: [agent, 集成, 上手]
---

# F30 · Agent 指南自动维护(CLAUDE.md / AGENTS.md)

> 一句话:在项目的 `CLAUDE.md` / `AGENTS.md` 里**自动维护一段托管区块**——"过程文档走 docky"的政策 + 当前关键文档索引——让**任何 harness 的 agent**(不只装了 MCP/hooks 的)都被指引到 docky。

## 背景与痛点

docky 引导 agent 的方式目前是**易失的、且依赖特定环境**:

- SessionStart hook 的 `contextText(vault, cwd, initialized)` 在**每次会话临时注入**政策与文档清单(`src/hooks.ts`),但这只惠及**装了 docky hooks 的 Claude Code**会话。
- 换个 harness、或没装 hooks 的 agent、甚至人类读者,看的是仓库里的 `CLAUDE.md` / `AGENTS.md`——而 docky **完全不维护**这块持久指引。
- 结果:"过程文档在 docky、关键设计在哪几篇"这类**最该常驻**的信息,没有一个持久、跨工具的落点。

## 目标 / 非目标

**目标**
- `docky guide sync`(可选挂到 F08 提交后):在项目 `CLAUDE.md`/`AGENTS.md` 中生成/刷新一段**带标记的托管区块**:
  - "过程文档统一走 docky(读优先 vault / 写用 write_doc)"政策;
  - **精选索引**:当前 active 的关键文档(F03 状态)、枢纽文档(F12/F21)、各类型入口,附 vault 路径。
- **幂等、不碰用户内容**:只改 `<!-- docky:start -->`…`<!-- docky:end -->` 之间(沿用 hooks 的幂等合并思路,`src/hooks.ts`)。
- 无 MCP/hooks 也能用(纯文件维护,harness 无关)。

**非目标**
- 不接管整篇 CLAUDE.md(只维护托管区块);不替代 SessionStart 注入(二者互补:一个持久、一个实时)。

## 用户故事

- 作为在其他工具里跑的 agent,我读项目 `AGENTS.md` 就知道"过程文档在 docky,关键设计是这三篇",照着走。
- 作为维护者,我 `docky guide sync` 一下,CLAUDE.md 的 docky 区块就更新到最新关键文档,且我手写的部分原封不动。

## 交互设计

```
$ docky guide sync
✓ 已更新 CLAUDE.md 的 docky 区块(政策 + 6 篇关键文档索引)

# CLAUDE.md 中(托管区块)
<!-- docky:start -->
## 过程文档(由 docky 维护)
- 政策:过程文档读优先 docky vault,写用 docky write_doc。
- 关键文档:
  - design/鉴权改造.md(active · 枢纽)
  - plan/路线.md(active)
<!-- docky:end -->
```

## 技术落点

- `src/guide.ts`:基于 `listDocs`+`filterDocs`(F03)+`buildContext`(F07)/F12·F21 选出关键文档,生成区块;在 `CLAUDE.md`/`AGENTS.md` 中按标记**幂等替换**(复用 `hooks.ts` 的合并范式)。
- `src/cli.ts`/`commands.ts`:`docky guide sync`;可选在 F08 `autocommit` 后触发。
- 写入项目仓库根(非 vault),与 hooks 的 WHITELIST(`hooks.ts`)语义一致,不污染普通文档。

## 验收标准

- [ ] `docky guide sync` 在 CLAUDE.md/AGENTS.md 生成/刷新带标记的 docky 托管区块。
- [ ] 区块含政策 + 当前关键文档(F03 active / F12·F21 枢纽)索引与路径。
- [ ] 幂等:重复运行只更新区块内,**绝不动用户其余内容**。
- [ ] 无 MCP/hooks 环境也能用;可选挂到 F08 提交后。
- [ ] `src/guide.ts` 的区块生成/幂等替换有单测。

## 衡量指标

- 非 Claude-Code/无 hooks 环境下 agent 正确走 docky 的比例提升。
- 项目 CLAUDE.md 的 docky 区块与库实际关键文档的"新鲜度"。

## 风险与依赖

- 严格幂等与标记边界,避免破坏用户手写内容(失败宁可不改)。
- 精选关键文档依赖 F03(状态)/F12·F21(枢纽);缺席时退化为"按类型列入口"。

## 与其他提案的关系(迭代递进)

- 与 **F25 互补**:F25 是 MCP 运行时原生能力,F30 是**持久、跨 harness 的指引文件**;再加 hooks 的实时注入,三层覆盖"agent 怎么知道用 docky"。
- 复用 **F07**(精选上下文)、**F03/F12/F21**(关键文档),把它们沉淀为常驻入口。
