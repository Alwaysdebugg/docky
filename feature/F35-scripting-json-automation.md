---
title: F35 · 脚本化与自动化(--json + 退出码 + stdin)
type: plan
owner: PM
status: proposed
priority: P1
effort: S
round: R7
created: 2026-06-17
tags: [自动化, cli, 生态]
---

# F35 · 脚本化与自动化(--json + 退出码 + stdin)

> 一句话:给 docky 一套**机器可读**的接口——`--json` 结构化输出、有意义的退出码、从 stdin 直接捕获——让它能被脚本、CI 和其他工具可靠地集成,而不只是给人看。

## 背景与痛点

docky 目前**只能给人看,难以被程序消费**:

- CLI 输出全是**人类排版文本**(`commands.ts` 里逐行 `line(...)`),`docky list`/`search`/`stats` 的结果无法被脚本稳定解析;全仓库**没有 `--json`**(仅有读 `settings.json` 文件的逻辑)。
- 退出码不成体系:CI 想用 `docky doctor`(F19)做门禁却拿不到可靠的非零退出。
- **捕获只能从文件**:`addDoc` 读取一个已存在文件(`core.ts`),无法 `生成内容 | docky add debug -` 这样从管道直接落库。

## 目标 / 非目标

**目标**
- **全局 `--json`**:`list/search/whoami/stats/doctor/todos/...` 输出结构化 JSON(同一套 schema)。
- **有意义的退出码**:成功 0;F19 有 error → 非零;未注册/越界等各有码,便于脚本判断。
- **stdin 捕获**:`docky add <类型> -` 从标准输入读取内容落库(快速管道捕获);可配 `--name`。
- **`--quiet`**:抑制装饰性输出,便于管道。

**非目标**
- 不改默认人类可读输出(`--json` 是可选叠加)。
- 不做长连接/守护进程式 API(那是 F27 web 的范畴)。

## 用户故事

- 作为脚本作者,我 `docky list --json | jq` 提取文档清单做自动化。
- 作为 CI,我跑 `docky doctor`,有 error 就非零退出、红掉流水线。
- 作为 agent/脚本,我把生成的排查内容 `... | docky add debug - --name 登录超时` 直接落库。

## 交互设计

```
$ docky list --json
[{"rel":"design/架构.md","type":"design","status":"active","tags":["登录"]}]
$ docky doctor ; echo $?
... 1            # 有 error,非零
$ printf '# 排查\n...' | docky add debug - --name 登录超时
✓ 已归档 debug/登录超时.md
```

## 技术落点

- 输出层:`executeCommand` 已返回结构化 `CommandResult`;新增一个 **JSON 渲染器**,`--json` 时输出数据而非文本行。
- `src/cli.ts`:全局 `--json`/`--quiet`;各命令定义退出码常量(F19 接入)。
- `src/core.ts`:`addDoc` 支持 `src === "-"` 时读 stdin。

## 验收标准

- [ ] 主要查询命令支持 `--json`,输出稳定 schema。
- [ ] 退出码成体系(成功 0、doctor 有 error 非零、未注册/越界各有码)。
- [ ] `docky add <类型> -` 从 stdin 落库;`--quiet` 生效。
- [ ] 默认人类输出不变;JSON 渲染与 stdin 捕获有单测。

## 衡量指标

- 经 `--json`/管道接入 docky 的脚本/CI 数。
- docky 被其他工具集成的场景数(生态广度)。

## 风险与依赖

- JSON schema 需稳定并版本化,避免破坏下游脚本。
- 为 **F34**(通用 webhook payload)与 CI 门禁(**F19**)提供基础;与 F27(web)分工(交互 vs 脚本)。

## 与其他提案的关系(迭代递进)

- 是 docky **生态集成的底座**:F34 的 webhook payload、CI 对 F19 的门禁都建立在此之上。
- 与 **F27** 互补:F27 面向人的交互浏览,F35 面向机器的脚本自动化。
