---
title: F37 · 健壮性与错误自愈
type: plan
owner: PM
status: proposed
priority: P1
effort: M
round: R8
created: 2026-06-17
tags: [健壮性, 数据安全, 错误恢复]
---

# F37 · 健壮性与错误自愈

> 一句话:让 docky 的各类**状态文件**(config / 最近 / oplog / 缓存 / 向量索引)**写得原子、读得容错、坏了能修**,任何基础设施损坏都不连累文档本身,也不抛栈给用户。

## 背景与痛点

状态文件越来越多,但**健壮性是零散的**:

- `config.json`、`.docky-state.json`(F04)、`.docky-oplog.json`(F10)、缓存(F36)、向量索引(F26)——多为直接 `writeFileSync`,**进程中断可能写坏**;读时多为局部 try/catch(如 `parseFrontmatter`、F04"损坏时重置"),**没有统一的校验/恢复/备份**。
- 一个损坏的 `config.json` 可能让命令整体失败,错误还是裸 `Error` 栈,用户无从下手。
- F19 巡检管的是**文档**质量,**基础设施文件**的健康无人负责。

## 目标 / 非目标

**目标**
- **原子写**:所有状态/配置写入走"写临时文件 + rename",杜绝半截文件。
- **容错读 + 备份**:加载时 schema 校验,损坏则**备份坏文件并安全回退默认**(绝不静默丢文档)。
- **基础设施自检与修复**:`docky repair`(区别于 F19 修文档)——检查/修复 config/state/oplog/cache/index。
- **可读的错误**:把内部异常归一化为"出了什么事 + 怎么办"的提示,而非栈。

**非目标**
- 不替代 F19(文档质量)与 F10(误删恢复);F37 专注**基础设施文件**的健壮。
- 不做事务型数据库(轻量原子写 + 校验即可)。

## 用户故事

- 作为用户,断电后再开 docky 一切照常——坏掉的缓存被自动重建,文档分毫无损。
- 作为用户,config 被我手改坏了,docky 提示"已备份并回退默认,请检查 X",而不是崩。

## 交互设计

```
$ docky
⚠ .docky-state.json 损坏,已备份为 .docky-state.json.bak 并重置(文档未受影响)。
$ docky repair
✓ config ok · state 已重置 · cache 已重建 · index ok
```

## 技术落点

- 新增 `src/safeio.ts`:`atomicWrite`(temp+rename)、`readJsonSafe(path, schema, fallback)`(校验+备份+回退);全状态读写改走它。
- `docky repair`:逐项检查/重建 config/state/oplog/cache(F36)/向量索引(F26)。
- 错误归一化:核心抛 `DockyError` 时附"下一步"(沿用 F05 的"可执行错误"风格)。

## 验收标准

- [ ] 所有状态/配置写入为原子(中断不产生半截文件)。
- [ ] 损坏文件被备份并安全回退默认,文档绝不受影响。
- [ ] `docky repair` 能体检并修复基础设施文件。
- [ ] 面向用户的错误可读、带下一步,无裸栈。
- [ ] 原子写/容错读/repair 有单测(含注入损坏文件)。

## 衡量指标

- 因状态损坏导致的崩溃/不可用归零。
- 崩溃/中断后无需人工干预即恢复的比例。

## 风险与依赖

- 原子 rename 跨文件系统需同卷;注意 Windows 兼容(本项目以 macOS/Linux 为主)。
- 与 F36(缓存)/F26(索引)/F10(oplog)/F04(state)/F18(config)协同:它们的读写统一改走 `safeio`。

## 与其他提案的关系(迭代递进)

- 与 **F36** 互为"内功"双子:快(F36)+ 稳(F37),共享原子 IO。
- 是 **F08** 数据安全的延伸:F08 保住文档历史,F37 保住围绕文档的全部状态;与 **F19**(文档)分工(基础设施)。
