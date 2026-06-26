---
title: F18 · 配置与偏好管理
type: plan
owner: PM
status: done
priority: P1
effort: S
round: R4
created: 2026-06-17
completed: 2026-06-18
tags: [治理, 配置, cli]
---

# F18 · 配置与偏好管理

> 一句话:给 docky 一个真正的设置入口 `docky config`,把散落各处、只能手改 JSON 的偏好(陈旧阈值、自动提交、编辑器/分页器、默认项目、授权)统一可查可改。

## 背景与痛点

配置项在变多,但**没有任何管理入口**:

- 配置由 `loadConfig`/`saveConfig` 读写 vault 内 `config.json`(`src/config.ts`),结构 `Config = { version, types, projects, staleDays, autocommit }`(`src/types.ts`)。
- 其中 `staleDays`(F03 已落地、默认 30)目前**只能手编 JSON** 才能改——没有 `docky config` 命令(`src/cli.ts` 无)。
- 随着后续提案落地,偏好会继续累积:自动提交模式(F08)、编辑器/分页器/渲染主题(F16/F01)、默认项目、跨项目授权(F15)。再不收口,用户体验就是"去翻 JSON"。

## 目标 / 非目标

**目标**
- `docky config`(列出全部)/ `docky config get <键>` / `docky config set <键> <值>`;TUI `/config` 只读查看 + 引导修改。
- 纳管的键(随相关提案上线增量接入):`staleDays`(F03)、`autocommit`(F08)、`editor`/`pager`/`theme`/`width`(F16/F01)、`defaultProject`、`grants` 摘要(F15)。
- 写入经 `saveConfig` 并**带类型/取值校验**(非法值拒绝并提示合法范围)。
- 区分"vault 级配置"与"用户偏好"(后者可放 `~/.docky` 或环境变量覆盖)。

**非目标**
- 不做图形化设置面板(CLI/TUI 文本即可)。
- 不接管 `projects` 的注册(那是 `register`/F05 的职责;config 只读展示)。

## 用户故事

- 作为维护者,我 `docky config set staleDays 14`,把陈旧阈值收紧,无需手改 JSON。
- 作为用户,我 `docky config` 一眼看清当前所有偏好与默认值。

## 交互设计

```
$ docky config
vault         ~/docky-vault
staleDays     30        (F03 陈旧阈值,天)
autocommit    auto      (F08)
editor        $EDITOR   theme  auto   width 0(自适应)
defaultProj   my-app
$ docky config set staleDays 14
✓ staleDays = 14
```

## 技术落点

- `src/config.ts`:新增 `getConfigValue`/`setConfigValue`(带 schema 校验)、键的元信息(说明/默认/取值域);保留 `saveConfig` 落盘。
- `src/cli.ts` / `src/commands.ts`:`config` 子命令与 `/config`。
- 用户级偏好:支持环境变量/家目录覆盖(与现有 `DOCKY_VAULT` 思路一致)。

## 验收标准

- [x] `docky config` 列出全部键、当前值、默认值与说明。
- [x] `get`/`set` 生效并持久化;非法值被拒并提示合法范围。
- [x] `set staleDays N` 立即影响 F03 的陈旧判定。
- [x] TUI `/config` 可查看;作用域/隔离不受影响。
- [x] 配置读写与校验有单测(参考 `test/`,向后兼容旧 config)。

## 衡量指标

- 因改配置而手编 JSON 的次数归零。
- 偏好(主题/编辑器/staleDays)被用户主动调整的比例。

## 风险与依赖

- 向后兼容:旧 config 缺字段时给默认,不报错(沿用 F03 的容错风格)。
- 与后续提案弱耦合:键按需接入,缺席的提案对应键暂不暴露。

## 与其他提案的关系(迭代递进)

- 成为 **F03(staleDays)/F08(autocommit)/F15(grants)/F16(主题宽度)/F01(编辑器分页器)** 的统一控制面。
- 与 **F19 巡检** 互补:config 管"该怎样",lint 查"实际是否如此"。

## 实现记录

- done — 2026-06-18 实现并通过测试(197/197)。
  - `src/config.ts`:`CONFIG_KEYS` 键注册表(说明/默认/getter/带校验的 setter);`getConfigValue`/`setConfigValue`(非法值与未知键抛 `DockyError` 并提示合法范围)/`listConfig`(当前值 + 默认 + 说明);写入经既有 `saveConfig` 落盘。纳管键:`staleDays`(F03)、`autocommit`(F08)、`theme`/`width`(F16);`width=0` 表示自适应(→ undefined)。
  - `src/cli.ts`:`docky config`(列出 vault + 全部键)、`config <key>`/`config get <key>`(取值)、`config <key> <value>`/`config set <key> <value>`(改值,变更键标注"默认 …")——两种语法皆支持。
  - `src/commands.ts`:`/config` 只读查看,并提示用 `docky config set` 修改。
  - 向后兼容:旧 config 缺字段一律给默认(沿用 F03 容错),既有单测全过;作用域/隔离不受影响。
  - 测试:`test/config.test.ts`(列出键+默认、get/set 持久化往返、非法值/未知键被拒、**`set staleDays 14` 立即影响 F03 陈旧判定**、旧 config 缺字段回落默认)+ `test/tui.test.tsx`(`/config` 只读展示)。CLI 实测 list/get/set/简写/非法拒绝。
  - 备注:editor/pager 仍走 `$EDITOR`/`$PAGER` 环境变量(未来可按需接入为 config 键);`defaultProject` 暂未纳管(尚无对应字段),随后续接入。
