---
title: F40 · 多语言界面(i18n)
type: plan
owner: PM
status: proposed
priority: P1
effort: M
round: R8
created: 2026-06-17
tags: [i18n, 可达性, 采纳]
---

# F40 · 多语言界面(i18n)

> 一句话:把界面文案抽进可切换的语言包,先支持中/英,让非中文用户也能用上 docky,而不是被一屏中文挡在门外。

## 背景与痛点

docky 的文案**全是硬编码中文**:

- 字标副标题、提示、错误、命令说明等**散落在 `src/tui.tsx` / `src/commands.ts` / `src/cli.ts` 里直接写死**(如 `COMMANDS` 的 `desc`、各 `line(...)` 文案、`/help` 文案)。
- **没有任何 i18n 脚手架**(全仓库无 locale/translate)。
- 结果:英文/其他语言用户面对满屏中文,**直接劝退**——再多功能也触达不到他们。

## 目标 / 非目标

**目标**
- **文案外置**:抽进消息目录(`locales/zh-CN.json`、`en.json`),代码用 `t(key, vars)` 取。
- **语言解析**:`locale` 经 F18 配置 / `DOCKY_LANG` / 系统语言;缺失键回退(en↔zh)。
- 先交付 **zh-CN + en**,覆盖 CLI/TUI 与面向用户的 MCP 文案。
- 预留可贡献的语言包结构,便于后续加语言。

**非目标**
- 不翻译用户的**文档内容**(只翻 docky 自身界面)。
- 首版不做复数/RTL 等高级本地化(预留结构)。

## 用户故事

- 作为英文用户,我 `DOCKY_LANG=en docky`,界面全英文,顺畅上手。
- 作为团队,我们把 locale 设为 en 作为默认,新人无语言门槛。

## 交互设计

```
$ DOCKY_LANG=en docky list
design/  architecture.md   [active]
2 docs
$ docky config set locale en      # 经 F18 持久化
```

## 技术落点

- 新增 `src/i18n.ts`:`t(key, vars)` + 目录加载;`src/locales/{zh-CN,en}.json`。
- 替换 `tui.tsx`/`commands.ts`/`cli.ts` 中的硬编码字符串为 `t(...)`(含 `COMMANDS.desc`)。
- locale 解析:F18 配置 > `DOCKY_LANG` > 系统 > 默认;缺键回退。

## 验收标准

- [ ] 界面文案经 `t()` 取自语言包;提供 zh-CN 与 en 两套。
- [ ] locale 经 F18/`DOCKY_LANG`/系统解析,缺键安全回退。
- [ ] CLI/TUI/面向用户的 MCP 文案均被本地化。
- [ ] 不影响文档内容;新增语言只需加一个 JSON。
- [ ] i18n 解析与回退有单测;关键流程的 en 快照测试。

## 衡量指标

- 非 zh-CN locale 的使用比例(国际可达性)。
- 英文环境下的上手完成率。

## 风险与依赖

- 字符串抽取工作量大且易漏:可分模块推进,先核心命令与错误。
- locale 持久化复用 F18;与 F39(可达性)、F38(可发现性)同属"人人可用"。

## 与其他提案的关系(迭代递进)

- 把整套 R1–R7 的功能从"仅中文"扩展到**多语言可达**;locale 经 **F18** 管理。
- 与 **F38/F39** 共同构成 R8 的"人人可用"内功底座(发现得到 + 看得清 + 读得懂)。
