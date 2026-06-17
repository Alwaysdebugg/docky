---
title: F15 · 跨项目授权检索与引用
type: plan
owner: PM
status: proposed
priority: P1
effort: M
round: R3
created: 2026-06-17
tags: [作用域, 授权, agent, 检索]
---

# F15 · 跨项目授权检索与引用

> 一句话:在**保持默认硬隔离**的前提下,引入**显式、可审计的授权**,让确有需要的项目能只读地检索/引用被授权项目的文档(写操作永不跨界)。

## 背景与痛点

硬隔离是 docky 的安全基石,但也带来"该看的看不到":

- `resolveProject` 解析失败即报错、绝不回退全局;`safePath` 对任何 `../` 越界一律拒绝(`src/core.ts`)——这是对的默认。
- 但现实里**确有合法的跨项目需求**:两个服务共享一份鉴权设计、平台团队的规范要被多个项目引用。今天**完全无解**,只能复制粘贴,导致文档分叉、不一致。
- 路线图已列出 **「跨项目授权访问」**(`README.md` 末尾),但缺一份落地方案。

> 原则不变:**默认全隔离;跨界只读且需显式授权;写操作永不跨项目;`../` 路径穿越仍硬拒。**

## 目标 / 非目标

**目标**
- 配置式授权:`grants`,如 `{ "svc-a": ["platform:design", "svc-b"] }`(可精确到类型)。
- **跨项目只读检索/引用**:`docky search --across`、TUI `/search` 可选纳入被授权项目;F12 的 `[[platform:design/规范]]` 可解析到被授权项目;F07 `get_context(scopes)` 在授权范围内聚合。
- 结果**清晰标注来源项目**,绝不与本项目文档混淆。
- **可审计**:`docky grants` 查看谁被授权访问谁;授权变更留痕(配合 F08 提交)。

**非目标**
- 不开放跨项目**写**(add/write/mv/rm 永远限定本项目)。
- 不做用户/角色权限体系(本轮是项目级 grant);不放松 `../` 穿越防护。

## 用户故事

- 作为 svc-a 的 agent,我被授权读 `platform:design`,`get_context` 便能把平台规范纳入上下文,而读不到任何未授权项目。
- 作为平台维护者,我 `docky grants` 一眼看清规范被哪些项目引用。

## 交互设计

```
$ docky search 限流 --across
[svc-a]      design/网关设计.md:20   …本项目命中…
[platform↗]  design/限流规范.md:5    …被授权(只读)…
$ docky grants
svc-a  →  platform:design (只读), svc-b (只读)
```

## 技术落点

- `src/config.ts`:新增 `grants` 结构与读写;`docky grant/revoke/grants` 命令。
- `src/core.ts`:新增 `resolveScopes(vault, project)` 返回 [本项目 + 授权(类型级)];`searchAcross`/`listAcross` 在各自 `safePath` 内分别检索后合并并打来源标签;**写路径完全不走** scopes。
- `src/mcp.ts`:`get_context`/`search_docs` 接受可选 scopes,服务端按 grants 过滤(客户端无法越权)。
- F12 链接解析支持 `项目:type/name` 且仅在授权范围内解析。

## 验收标准

- [ ] 默认无 grant 时,行为与今天**完全一致**(全隔离),既有隔离单测不破。
- [ ] 配置 grant 后,`--across`/`get_context(scopes)` 可只读检索被授权项目,结果带来源标签。
- [ ] 任何写操作均不跨项目;`../` 穿越仍被 `safePath` 拒绝。
- [ ] `docky grants` 可审计;授权变更可追溯(F08 提交)。
- [ ] 跨项目检索/解析有单测,含"未授权不可见"的负向用例。

## 衡量指标

- 因隔离导致的"复制粘贴跨项目文档"行为减少。
- 越权访问尝试被拒次数(应 100% 拒绝)。

## 风险与依赖

- 安全第一:授权解析必须在**服务端/核心层**强制,MCP 客户端不可自带 scope 绕过。
- 默认关闭、最小授权;UI 清晰标注"↗ 跨项目只读",避免误以为可改。

## 与其他提案的关系(迭代递进)

- 在 **F05/`safePath`** 的隔离保证之上做"受控开口",不破坏其语义。
- 直接扩展 **F07**(上下文可跨授权域)、**F13**(跨域相关性排序)、**F12**(跨域链接)——R3 的边界扩展收口。
