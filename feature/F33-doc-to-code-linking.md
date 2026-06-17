---
title: F33 · 文档↔代码关联
type: plan
owner: PM
status: proposed
priority: P1
effort: M
round: R7
created: 2026-06-17
tags: [集成, 代码, 导航]
---

# F33 · 文档↔代码关联

> 一句话:让文档能**指向它所描述的代码**(文件:行 / 提交),从文档一键跳到代码,并反查"哪些文档在讲这个文件"——把过程文档和它的代码对象连起来。

## 背景与痛点

docky 的文档天生是**关于代码**的,却和代码**断联**:

- 归档时 frontmatter 只记了 `branch`(`buildFrontmatter`,`src/core.ts`),**没有任何具体代码位置/提交**的关联。
- 一篇 debug 文档讲某个 bug,却**点不到出问题的函数**;想反查"关于 `src/auth.ts` 有哪些设计/排查",**无从下手**。
- docky 其实**已经知道项目的 git 根与分支**(`core.gitRoot`/`gitBranch`),具备做关联的基础,只是没用起来。

## 目标 / 非目标

**目标**
- **代码引用**:文档可携带代码关联(frontmatter `code: [src/auth.ts, <commit>]` 或正文 `[[code:src/auth.ts]]`);`docky link-code <rel> <path:line|commit>`。
- **文档→代码**:从文档一键打开引用的代码(编辑器定位到行,复用 F01 `openExternally(path,line)`)。
- **代码→文档(反查)**:`docky docs-for <path>` 列出引用了该代码文件的文档(类比 F12 反链,但跨"文档↔代码")。
- **智能预填**:在 git 仓库内 `/new debug|design` 时,可建议关联当前文件/最近提交(F06 模板预填)。

**非目标**
- 不做代码内容索引/搜索(只做"位置关联",代码搜索交给 IDE)。
- 不强制关联;无关联的文档照常工作。

## 用户故事

- 作为开发者,读 debug 文档时按一下就跳到 `src/auth.ts` 那个函数。
- 作为接手者,`docky docs-for src/auth.ts` 立刻看到围绕这个文件的全部设计与排查。

## 交互设计

```
# design/鉴权改造.md(阅读视图底部)
关联代码 →  src/auth.ts · src/session.ts · @abc123
$ docky docs-for src/auth.ts
  design/鉴权改造.md   · debug/登录超时.md
```

## 技术落点

- `src/types.ts` / frontmatter:新增 `code: string[]`(`path:line` 或 commit)。
- `src/codelink.ts`:解析/校验代码引用(对照项目 `gitRoot`);构建"代码→文档"反查索引。
- 跳转复用 F01 `openExternally(path, line)`;阅读视图(F16)展示关联;`link-code`/`docs-for` 命令。

## 验收标准

- [ ] 文档可关联代码位置(frontmatter/正文/`link-code`),并在阅读视图展示。
- [ ] 从文档一键打开引用代码并定位到行。
- [ ] `docky docs-for <path>` 反查引用该代码的文档。
- [ ] 关联解析对照项目 git 根;无效引用标注。
- [ ] `src/codelink.ts` 有单测;作用域隔离不变。

## 衡量指标

- 带代码关联的 debug/design 文档占比。
- 经 `docs-for` 完成的"代码→文档"反查次数。

## 风险与依赖

- 代码位置会随改动漂移:用 `path:line` + 可选 commit 锚定,失效时提示而非误跳。
- 复用 F01(打开)、F06(模板预填)、F16(展示)、gitRoot(已具备)。

## 与其他提案的关系(迭代递进)

- 把 **F12 的"文档↔文档"互链**延伸到 **"文档↔代码"**,补上过程文档与代码对象之间最后一公里。
- 反查能力可并入 **F21 仪表盘**(热点代码对应的文档密度)。
