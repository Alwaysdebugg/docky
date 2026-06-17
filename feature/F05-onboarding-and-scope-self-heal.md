---
title: F05 · 新手引导与作用域自愈
type: plan
owner: PM
status: done
priority: P1
effort: S
round: R1
created: 2026-06-17
completed: 2026-06-17
tags: [采纳, 上手, 错误恢复]
---

# F05 · 新手引导与作用域自愈

> 一句话:让"未初始化 vault / 未注册仓库"不再是死胡同——在出错的当下就**给出可一键执行的下一步**,把新用户顺滑送达"已注册、有作用域"的状态。

## 背景与痛点

docky 的安全设计很对(**绝不静默回退到全局**),但**恢复路径**对新人不友好:

- `core.resolveProject` 在仓库未注册时直接 `throw`;TUI 的 `detectProject` 把异常**吞掉返回 null**(`src/tui.tsx`),于是新人进来只看到 `[no project]`,不知道为什么、也不知道怎么办。
- 上手是隐式两步:先 `docky init` 建中心仓库,再 `docky register`/`/init` 注册项目(README「快速上手」),容易漏第二步。
- CLI 命令在解析失败时给的是错误,而**没有把"该敲哪条命令修复"直接喂到嘴边**(其实仓库名可由 `core.gitRoot` 的 basename 推断出来)。

> 安全约束不变,但每个死胡同都应配一个"按这个就好"的出口。

## 目标 / 非目标

**目标**
- **首次运行引导**:vault 不存在时,TUI 友好提示并提供一键 `init`(而非让用户自己去查 README)。
- **作用域自愈**:当 cwd 是 git 仓库但未注册,主页显示行动卡片「此仓库未注册 → 按 `R` 注册为 `<推断名>`」,一键完成 `/init` 并切到该项目。
- **可执行的错误**:CLI/TUI 解析失败时,直接打印**填好推断名的命令**:`docky register <推断名>`,复制即用。
- `whoami` 失败时,给出明确的下一步而非裸错误。

**非目标**
- 不改变"绝不静默回退到全局"的安全语义。
- 不做账号体系/远程引导(纯本地 onboarding)。

## 用户故事

- 作为第一次用 docky 的人,我在一个新仓库敲 `docky`,被告知"此仓库未注册,按 R 注册为 my-app",一键就进入了带作用域的工作台。
- 作为偶尔切换项目的人,我在未注册目录运行命令时,终端直接给我 `docky register my-app`,我粘贴回车即可。

## 交互设计

```
DOCKY
此目录是 git 仓库但尚未注册到 docky。
  ▸ 按 R 注册为  my-app   (~/code/my-app)
  或手动:docky register my-app
[no project] ›
```

CLI 解析失败示例:
```
$ docky list
✗ 当前目录未注册到 docky。
  → 运行:docky register my-app      # 已按仓库名预填
```

## 技术落点

- `src/tui.tsx`:`detectProject` 升级为返回结构化结果 `{ project } | { unregisteredRepo, suggestedName } | { noVault } | null`;主页据此渲染对应行动卡片;`R` 键触发 `/init <suggestedName>`(复用 `commands.ts` 的 `init` 分支)。
- `src/core.ts`:抽出"推断仓库名"工具(`gitRoot` basename),供引导与错误提示共用。
- `src/cli.ts`:命令在 `DockyError(未注册)` 时,统一追加一行"→ 运行:docky register <推断名>"。
- `src/config.ts` / `init`:vault 缺失时的首次引导文案与一键创建。

## 验收标准

- [x] vault 不存在时,TUI 给出引导并可一键创建,而非裸报错。
- [x] 未注册的 git 仓库:主页出现"按 R 注册为 <推断名>"卡片,`R` 一键注册并切换作用域。
- [x] CLI 在解析失败时,输出**预填仓库名**的 `docky register <name>` 建议。
- [x] `whoami` 在失败路径给出明确下一步。
- [x] "绝不静默回退到全局"的行为与既有单测不被破坏。
- [x] 新增单测覆盖三种状态(已注册 / 未注册仓库 / 无 vault)的分支。

## 衡量指标

- 新用户从首次启动到"成功注册第一个项目"的转化率与步数。
- `[no project]` 死胡同停留(无后续有效命令)的发生率下降。

## 风险与依赖

- 需准确区分"未注册仓库"与"根本不是 git 仓库"两种情况,文案不同。
- 一键注册要复用既有 `registerProject`,避免与 `docky register` 行为分叉。

## 与其他提案的关系

- 独立的采纳漏斗修复,可与 F01–F04 并行。
- 用户被自愈引导进入作用域后,**F04 主页**(最近/置顶)立即接管,形成连贯的"上手 → 工作台"体验。

## 实现记录

- done — 2026-06-17 实现并通过测试(106/106)。
  - `src/types.ts`:新增 `ScopeDetection` 联合类型(registered / unregistered-repo / no-repo / no-vault)。
  - `src/core.ts`:`inferRepoName`(git 仓库名→否则目录名)与 `detectScope`(分类当前目录,**绝不回退全局**:未注册仍是未注册,只附带建议名)。
  - `src/tui.tsx`:`detectProject` 改用 `detectScope`;主页据 scope 渲染行动卡片(无 vault / 未注册仓库 / 非 git 目录三种文案);新增 `selfHeal()` 与 `R` 键(仅在"无项目且输入为空"时触发,不劫持正常输入)——一键创建 vault 并按推断名注册当前目录、切入作用域。
  - `src/commands.ts`:`/whoami` 失败路径改为给出"→ 运行 /init 注册为 <推断名>(或 docky register <名>)"的明确下一步。
  - `src/cli.ts`:`resolve()` 解析失败时打印**预填仓库名**的 `docky register <name>` 建议;`launchTui` 不再 `requireInit`,无 vault 也能进入带引导卡片的 TUI。
  - 安全语义不变:既有"未注册即抛、绝不静默全局"单测全部通过。
  - 测试:`test/core.test.ts`(inferRepoName + detectScope 四态)、`test/commands.test.ts`(whoami 可执行提示)、`test/tui.test.tsx`(未注册仓库卡片 + `R` 自愈、无 vault 卡片)。
  - 备注:`R` 自愈对 unregistered-repo 用 git 根路径注册、对 no-repo 用 cwd 注册,均复用既有 `registerProject`,与 `docky register` 行为一致。
