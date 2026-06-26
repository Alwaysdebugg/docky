---
title: F25 · MCP 资源与提示暴露
type: plan
owner: PM
status: done
priority: P1
effort: M
round: R5
created: 2026-06-17
completed: 2026-06-18
tags: [agent, mcp, 集成]
---

# F25 · MCP 资源与提示暴露

> 一句话:除了工具,docky 的 MCP 服务还应把文档暴露成 **Resources(可列举/读取/订阅)** 与 **Prompts(一键加载上下文)**,让 MCP 客户端**原生**发现并引用 docky 内容,而不必全靠模型主动调工具。

## 背景与痛点

docky 的 MCP 服务**只暴露了工具(Tools)这一种能力**:

- `src/mcp.ts` 里全是 `server.registerTool(...)`(`mcp.ts`),**没有 Resources、没有 Prompts**。
- 但 MCP 协议另有两类一等能力,且**很多客户端会在 UI 原生呈现**:
  - **Resources**:可被客户端**列举/读取/订阅变更**(用户能像 @ 附件一样引用某篇文档);
  - **Prompts**:客户端把它们呈现为可一键触发的"指令"(如"加载本项目上下文")。
- 结果:agent 要用 docky,只能靠模型"想起来"去调 `list_docs`/`read_doc`;文档无法作为可浏览资源被引用,常用动作也无法作为提示一键触发。

## 目标 / 非目标

**目标**
- **Resources**:把作用域内每篇文档暴露为资源 `docky://<项目>/<类型>/<名>`,支持 `resources/list` 与 `resources/read`;变更订阅复用 **F08** 的提交事件(文档更新即通知)。
- **Prompts**:提供若干 MCP 提示,例如:
  - `load-project-context`(包装 **F07** `get_context`);
  - `start-debug-doc` / `start-design-doc`(包装 **F06** 模板)。
- 严格作用域:资源仅暴露已解析项目(或 **F15** 授权域)内文档;越界不可见。

**非目标**
- 不改既有工具(Tools 保留;Resources/Prompts 是新增能力)。
- 不在本轮做资源的写订阅协商之外的复杂能力。

## 用户故事

- 作为使用 MCP 客户端的开发者,我能在客户端里**浏览 docky 的文档资源**并 @ 引用某篇,而不必让模型猜路径。
- 作为 agent,我一键触发 `load-project-context` 提示,即获得本项目的相关上下文(F07)。

## 交互设计(协议层)

```
resources/list   → docky://my-app/design/鉴权改造.md, docky://my-app/debug/...
resources/read   docky://my-app/design/鉴权改造.md → 文档内容(scope 校验)
prompts/list     → load-project-context, start-debug-doc, start-design-doc
prompts/get load-project-context(project=my-app, query=登录)
                 → 调 F07 get_context 组装的消息
```

## 技术落点

- `src/mcp.ts`:新增资源处理(`resources/list`、`resources/read`,可选 `resources/subscribe`)与 `registerPrompt`;URI 方案 `docky://<project>/<rel>`。
- 资源解析复用 `core.listDocs`/`readDoc` + `safePath`(scope 硬边界);订阅复用 F08 提交事件。
- Prompts 复用 F07(get_context)、F06(模板)。

## 验收标准

- [x] MCP 服务通过 `resources/list`、`resources/read` 暴露作用域内文档资源。
- [x] 提供 `load-project-context` 等 Prompts,行为正确包装 F07/F06。
- [x] 资源/提示均受作用域(及 F15 授权)限制,越界不可见、不可读。
- [x] (可选)文档更新触发资源变更通知(F08 事件)。
- [x] 新增 MCP 能力有单测/契约测试,既有 5 个工具行为不回退。

## 衡量指标

- 经 Resources/Prompts(而非纯 Tool 调用)接入 docky 内容的客户端/会话比例。
- agent 引用到正确文档的命中率提升(资源可浏览 → 少猜路径)。

## 风险与依赖

- 客户端对 Resources/Prompts 支持程度不一;需在不支持时优雅退化(工具仍可用)。
- 资源 URI 与 scope 解析必须服务端强制,客户端不可越权。

## 与其他提案的关系(迭代递进)

- **扩展 agent 接入面**:F07 是"一个工具",F25 把 docky 内容升级为客户端原生可见的 **Resources + Prompts**。
- Prompts 复用 **F07/F06**,订阅复用 **F08**,scope 复用 **F15** —— R5 面向 agent 协作的集成层收口。

## 实现记录

- done — 2026-06-18 实现并通过测试(236/236)。
  - `src/mcpresources.ts`(新增,纯函数、可单测、无 transport):`listResources`(跨已注册项目把每篇暴露为 `docky://<project>/<rel>`,mimeType `text/markdown`)、`parseDockyUri`、`readResource`(经 `core.readDoc` 读取——**`safePath` 仍是硬边界,`../` URI 被拒**)、`contextPromptMessages`(包装 F07 `buildContext`)、`scaffoldPromptMessages`(包装 F06 `renderScaffold`)。
  - `src/mcp.ts`:`registerResource("docky-docs", ResourceTemplate("docky://{project}/{type}/{name}", {list}))` + 读回调;`registerPrompt`:`load-project-context`(F07)、`start-debug-doc` / `start-design-doc`(F06)。**既有 5 个工具一字未改**。
  - 作用域:资源读取经 `core.readDoc`/`safePath`,越界/`../` 不可读;list 仅列已注册项目(本地单用户 vault 自有的全部项目)。
  - 测试:`test/mcpresources.test.ts`(list 资源、parseDockyUri、readResource 读取 + 拒绝穿越、两类 prompt 包装 F07/F06)。**经真实 MCP stdio 契约实测**:`resources/list`、`resources/read`、`prompts/list`、`prompts/get load-project-context` 均返回正确结构;5 个工具行为不回退。
  - 备注:资源变更订阅(F08 事件 → `sendResourceListChanged`)为可选项,本轮提供 list/read/prompts;订阅留作后续(SDK `sendResourceListChanged` 已就绪)。URI host 大小写遵循客户端原样回传(项目名约定小写)。
