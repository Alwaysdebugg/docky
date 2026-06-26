---
title: F34 · 外部通知与集成
type: plan
owner: PM
status: proposed
priority: P1
effort: M
round: R7
created: 2026-06-17
tags: [集成, 通知, 生态]
---

# F34 · 外部通知与集成

> 一句话:把 docky 内部攒下的信号(变更动态、健康问题、待审 agent 产出)**主动推送到团队所在的地方**(Slack / 邮件 / 通用 webhook),而不是等人主动进 docky 才看见。

## 背景与痛点

docky 的有用信号**全憋在工具内部**:

- F28(变更动态)、F19(健康巡检)、F21(仪表盘)、F22(agent 待审)都只在**进入 docky 时**才看得到。
- 维护者不会每天开 docky,于是 **陈旧文档没人清、agent 待审堆积、断链无人管**——信息没有走到人面前。
- 没有任何**出站集成**(webhook/通知),docky 无法接入团队既有的 Slack/邮件/自动化流。

## 目标 / 非目标

**目标**
- `docky notify`(可手动 / 经 cron / 经 F08 提交后触发):构建一份**摘要**并推送到配置的渠道:
  - 自上次以来的变更(F28)、健康概览(F19)、待审 agent 产出(F22)、陈旧(F03)。
- **渠道**:Slack/Discord incoming webhook、邮件(SMTP)、**通用 webhook(JSON)**;渠道与频率/过滤经 **F18** 配置。
- 通用 webhook 的 payload 复用 **F35** 的结构化 JSON。
- 默认**仅在有内容时**推送,避免噪音。

**非目标**
- 不内建消息平台账号体系(用各平台的 incoming webhook/SMTP)。
- 不做双向(只出站通知;处置仍回 docky)。

## 用户故事

- 作为维护者,我配好 Slack webhook,每天早上群里自动收到"3 篇待审、2 篇陈旧、1 处断链"。
- 作为团队,我把 `docky notify` 接进 CI/cron,健康问题自动播报。

## 交互设计

```
$ docky notify --to slack
✓ 已推送摘要到 #docky:  变更 5 · 待审 3 · 陈旧 2 · 健康 ⚠1

# 通用 webhook(JSON,复用 F35)
POST <url>  { "changes": [...], "health": {...}, "pending": [...] }
```

## 技术落点

- `src/notify.ts`:聚合 F28/F19/F22/F03 → 摘要;渲染为各渠道格式(Slack blocks / 邮件 / JSON)。
- 发送:Node 内置 `https`/`fetch`(webhook)、SMTP(邮件,按需可选依赖)。
- 渠道配置经 **F18**;payload 复用 **F35** JSON。

## 验收标准

- [ ] `docky notify` 生成含 变更/健康/待审/陈旧 的摘要并推送到配置渠道。
- [ ] 支持 Slack/Discord webhook 与通用 JSON webhook(邮件可选)。
- [ ] 渠道/频率/过滤经 F18 配置;无内容时不打扰。
- [ ] 通用 webhook payload 与 F35 JSON 一致;发送失败有重试/报错。
- [ ] 摘要构建有单测(发送层可 mock)。

## 衡量指标

- 配置了通知渠道的团队比例。
- 通知触达后陈旧/待审被处理的时效提升。

## 风险与依赖

- webhook URL 属敏感配置,需安全存储(F18)、不入库不外泄。
- 依赖 F28/F19/F22(内容)、F18(渠道)、F35(JSON);缺席项在摘要中省略。

## 与其他提案的关系(迭代递进)

- 把 **F28/F19/F22/F21** 的内部信号**对外播报**,与 F28 互补(入站感知 vs 出站推送)。
- 通用 webhook 复用 **F35** 的结构化输出,共同构成 docky 的**生态集成层**。
