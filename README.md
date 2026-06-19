# docky

**集中管理 AI agent 辅助开发时产生的 Markdown 过程文档**——按 `项目 / 类型` 分类,与各业务仓库的 git 解耦,并对 agent 强制**按项目作用域隔离**读写。

CLI + MCP + Ink TUI,TypeScript 实现(`commander` + 官方 `@modelcontextprotocol/sdk` + `Ink`)。

> 一句话:让 design / plan / debug / code-review / prompts 这类"过程文档"有一个**统一、可检索、可版本化、且 agent 永远越不出项目边界**的家。

---

## 目录

- [为什么用 docky](#为什么用-docky)
- [核心概念](#核心概念)
- [安装](#安装)
- [快速上手](#快速上手)
- [CLI 命令参考](#cli-命令参考)
- [交互式 TUI](#交互式-tui)
- [MCP(给 AI agent 用)](#mcp给-ai-agent-用)
- [Claude Code 集成(hooks)](#claude-code-集成hooks)
- [数据安全模型](#数据安全模型)
- [作用域隔离](#作用域隔离)
- [中心仓库结构](#中心仓库结构)
- [配置](#配置)
- [开发](#开发)
- [路线图与提案](#路线图与提案)

---

## 为什么用 docky

AI agent 在帮你写代码时会产出大量过程文档:架构设计、排查记录、改造计划、code review、prompt 草稿……它们通常:

- **散落**在各业务仓库里,污染业务 git 历史;
- **难检索**,几个月后没人找得到;
- **无边界**——agent 可能读到/写到不该碰的地方。

docky 把这些文档收进一个**独立的中心仓库(vault)**,按 `项目/类型` 组织,提供检索、版本化、生命周期管理与 agent 友好的 MCP 接口,并用一条硬边界保证 **agent 永远只能在当前项目作用域内读写**。

## 核心概念

- **中心仓库(vault)**:独立 git 仓库,默认 `~/docky-vault`,可用环境变量 `DOCKY_VAULT` 覆盖。结构为 `projects/<项目>/<类型>/`。
- **类型(固定枚举)**:`design`、`plan`、`debug`、`code-review`、`prompts`。
- **生命周期状态**:`draft`、`active`、`done`、`archived`(写在 frontmatter `status:`)。`archived` 默认隐藏。
- **标签**:跨类型的 `tags:`,用于聚合("所有关于登录的文档")。
- **项目自动识别**:命令在某项目目录下运行时,按"工作目录 + git 仓库根 + 当前 branch"自动推断属于哪个项目;推断失败则明确报错并给出可执行的下一步,**绝不静默回退到全局**。

## 安装

本地开发(editable 风格,改代码即生效):

```bash
cd docky-ts
npm install          # 安装依赖并自动 build
npm link             # 把 docky / docky-mcp 挂到全局
```

或构建后全局安装:

```bash
npm install && npm run build
npm install -g .
```

> 用 Node 分发,无需处理 Python 的 PEP 668 / pipx 问题。也可用 `npx` 直接跑。要求 Node ≥ 18。

提供两个可执行文件:`docky`(CLI / TUI)与 `docky-mcp`(MCP 服务)。

## 快速上手

最省事的方式是一条 `setup` 命令(初始化 vault + 注册当前项目 + 安装 hooks + 提示如何接 agent):

```bash
cd ~/code/my-app
docky setup                 # 一键上手;--user 装全局 hooks,--name 指定项目名
```

或手动:

```bash
docky init                  # 初始化中心仓库
docky register my-app       # 注册当前目录为项目 my-app
docky whoami                # 确认当前目录解析到的项目/分支

docky new design 鉴权改造    # 用模板新建一篇设计稿(草稿)
docky add debug ./排查.md -f # 归档已有 md(-f 自动补 frontmatter)
docky list                  # 列出当前项目全部文档
docky search session        # 作用域内检索
docky                       # 不带参数 → 进入交互式 TUI
```

`-p/--project` 省略时一律自动推断当前项目。

## CLI 命令参考

### 上手与项目

| 命令 | 说明 |
|---|---|
| `docky setup [--user] [--name N] [--no-register] [--no-hooks]` | 一键上手:init + register + hooks + 接入提示 |
| `docky init [--no-git]` | 初始化中心仓库(骨架 + git) |
| `docky register <名> [--path P] [--link]` | 注册项目并登记本地路径 |
| `docky projects` | 列出已注册项目 |
| `docky whoami` | 显示当前目录解析到的项目/分支 |

### 文档增删改

| 命令 | 说明 |
|---|---|
| `docky new <类型> [名] [-p]` | 用类型模板新建文档(`status: draft`) |
| `docky add <类型> <文件...> [-p] [-f] [--name N] [--force]` | 归档已有 md(默认拒绝同名覆盖;`--force` 覆盖并把旧内容入 `.trash`) |
| `docky mv <相对路径> <目标类型> [--name N] [--force]` | 移动到另一类型(同名需 `--force`) |
| `docky rm <相对路径> [-y]` | 删除(移入 `.trash`,可恢复;需 `--yes` 确认) |
| `docky status <相对路径> <draft\|active\|done\|archived>` | 设置生命周期状态 |

### 检索与导航

| 命令 | 说明 |
|---|---|
| `docky list [类型] [-s 状态] [--tag T] [--stale] [--archived]` | 列出文档(状态/标签过滤;陈旧标 ⚠;archived 默认隐藏) |
| `docky search <关键词> [-t 类型] [--fuzzy] [--across]` | 相关性排序 + 多片段 + 命中高亮;`--fuzzy` 模糊;`--across` 跨授权项目 |
| `docky open <相对路径> [--raw] [--toc] [--width N] [--theme dark\|none]` | 渲染后用分页器查看(`--toc` 加目录) |
| `docky links <相对路径>` | 查看出链 / 反向链接 / 失效链接 |
| `docky recent` / `docky pin <rel>` / `docky unpin <rel>` | 最近访问 / 置顶 / 取消置顶 |
| `docky save <名> <查询...>` / `docky folders` / `docky open-folder <名>` / `docky unsave <名>` | 智能文件夹(把过滤/检索条件存为命名的动态视图) |

### 版本与安全(git-backed)

| 命令 | 说明 |
|---|---|
| `docky sync [--push]` | 提交 vault 未提交改动(可推送到已配置 remote) |
| `docky log <相对路径>` | 查看单篇演进历史 |
| `docky diff <相对路径> [revA] [revB]` | 查看差异(分页器,彩色) |
| `docky undo` | 撤销最近一次 删除 / 移动 / 强制覆盖 |
| `docky trash` / `docky restore <回收站名>` | 查看回收站 / 还原 |

> 默认开启自动提交(见[配置](#配置)),每次写操作都会进 git 历史。

### 知识库治理

| 命令 | 说明 |
|---|---|
| `docky index` | 生成/刷新当前项目 `INDEX.md` |
| `docky stats`(别名 `dashboard`) | 只读概览:类型×状态、被引用最多、孤立文档、标签热度、健康度 |
| `docky doctor`(别名 `lint`)`[--fix]` | 文档体检(缺 frontmatter / 断链 / 陈旧…),`--fix` 安全自动修复;有 error 时退出码非零(可用于 CI) |
| `docky graph [--dot]` | 关系图谱:枢纽 / 簇群 / 孤岛 / 断链(`--dot` 输出 Graphviz) |
| `docky inbox` / `docky review <rel> <pending\|approved>` | agent 产出审阅收件箱 |

### 导出与分享

| 命令 | 说明 |
|---|---|
| `docky export [--format site\|html\|md] [-t 类型] [-o 目录]` | 导出文档(默认整站 `site`:首页 + 每篇页,互链解析为锚点,徽标渲染) |
| `docky share <相对路径> [-o 文件]` | 导出单篇为自包含 HTML,便于直接发送 |

### 跨项目授权(默认全隔离)

| 命令 | 说明 |
|---|---|
| `docky grant <项目[:类型]>` | 授权当前项目**只读**访问另一项目(可精确到类型) |
| `docky revoke <项目[:类型]>` | 撤销授权 |
| `docky grants` | 查看全部跨项目授权(审计) |

> 跨项目只读且需显式授权;**写操作永不跨项目**,`../` 路径穿越一律拒绝。

### 配置 / 软链接 / 接管存量

| 命令 | 说明 |
|---|---|
| `docky config [<键> [值]]` / `docky config get\|set <键> [值]` | 查看/修改偏好 |
| `docky link` / `docky unlink` | 在项目内建立/移除 symlink(并维护 `.gitignore`) |
| `docky import [目录] [--apply] [--move] [-i] [--tags a,b]` | 扫描散落 .md 并按启发式归类(默认 dry-run 预览,`-i` 交互式三筛) |

### 集成

| 命令 | 说明 |
|---|---|
| `docky ui` / 裸 `docky` | 启动交互式 TUI |
| `docky hooks install [--user]` | 安装 Claude Code hooks |
| `docky-mcp` | 启动 MCP 服务(stdio) |

## 交互式 TUI

直接运行 `docky`(不带参数)或 `docky ui` 进入。仿 Claude Code 的单输入框 REPL,**没有分栏**:命令结果从上往下流式打印,底部一个命令输入框。

- 输入 `/` 弹出**全部命令菜单**(随输入实时过滤),`↑/↓` 选择,`Tab` 补全(命令名,以及**参数级补全**:路径/类型/项目名),`Enter` 执行。
- `Ctrl-P` 或 `/o` 唤起**模糊快速打开**:几个字符定位任意文档并打开。
- `/list` 进入**层级文档浏览器**(可多选,批量 移动/删除/打标/改状态)。
- `/search` 结果**可上下选中、回车直达匹配行**;`/open` 在同终端分页器中渲染查看(按 `q` 返回)。
- `/recent`、`/folders`、`/graph`、`/inbox`、`/dashboard`、`/doctor` 等均有交互视图。
- 进入时自动按当前目录推断项目;`/use <项目>` 切换作用域;未注册仓库会显示"按键一键注册"的引导卡片。
- 命令开头的 `/` 可带可不带;`/help` 看全部命令,`/exit`(别名 `/quit`)退出。

所有 TUI 命令都被限制在当前项目作用域内。

## MCP(给 AI agent 用)

启动(stdio):

```bash
docky-mcp                   # 或 node dist/mcp.js / npm run mcp
```

接入 Claude Code(推荐全局):

```bash
claude mcp add --scope user docky -- docky-mcp
```

其他 MCP 客户端配置:

```json
{ "mcpServers": { "docky": { "command": "docky-mcp" } } }
```

### Tools(全部按 `project` 作用域隔离,越界路径一律拒绝)

| 工具 | 用途 |
|---|---|
| `resolve_project(cwd)` | 由工作目录推断项目与分支(失败即抛,不回退全局) |
| `list_docs(project, type?, status?, tag?)` | 列出作用域内文档(archived 默认隐藏) |
| `read_doc(project, path)` | 读取单篇,路径越界拒绝 |
| `search_docs(project, query, type?, fuzzy?, across?)` | 相关性检索(多片段、高亮;`across` 含授权项目) |
| `write_doc(project, type, name, content?, scaffold?, mode?)` | **智能写入**(见下);`scaffold` 套类型模板 |
| `get_context(project, query?, budget?, across?)` | 一次返回排序、去陈旧、按 token 预算截断的相关文档包 |

**`write_doc` 智能模式(F20)**:默认 `mode="new"` 时,若命中**同名或近似**文档,**不会静默覆盖/重复**——而是返回结构化建议(候选 + 相似度),让 agent 选择 `append`(带时间戳追加)/ `merge`(返回合并预览)/ `replace`(显式覆盖,旧内容入 `.trash` 可撤销)。agent 写入默认带 `source: agent, review: pending`,进入审阅收件箱(`docky inbox`)。

### Resources & Prompts

- **Resources**:每篇文档暴露为 `docky://<项目>/<类型>/<名>`,客户端可列举/读取(作用域内)。
- **Prompts**:`load-project-context`(包装 `get_context`)、`start-debug-doc`、`start-design-doc`(套模板)。

## Claude Code 集成(hooks)

让 agent 默认走 docky 读写过程文档,一条命令安装护栏(幂等):

```bash
docky hooks install          # 写入 ./.claude/settings.json(项目级)
docky hooks install --user   # 或写入 ~/.claude/settings.json(全局)
```

安装两个 hook:

- `SessionStart → docky hooks context`:会话开始注入"过程文档走 docky"的政策,并列出当前项目已有文档,引导优先从中心仓库读。
- `PreToolUse (Edit|Write) → docky hooks guard`:当 agent 想把过程类 `.md` 写进业务仓库时**拦截**并提示改用 `write_doc`;放行 README/CHANGELOG 等常规文档与写入 vault 的文件。

> hook 只能拦截/放行/注入上下文,不能强制模型去调某个工具;"读优先走 vault" 主要靠 SessionStart 注入 + `CLAUDE.md` 引导,写这一侧由 PreToolUse 硬护栏兜底。

## 数据安全模型

docky 把"过程文档不该因误操作而丢失"作为底线,三层兜底:

- **自动版本化**:每次写/删/移默认自动 `git commit`(`autocommit: auto`),进 git 历史可 `log`/`diff`/回溯。
- **软删除 + 撤销**:`rm` 移入项目内 `.trash/` 而非物理删除;`add`/`mv` 同名默认拒绝覆盖,`--force` 覆盖也会先备份旧内容;`docky undo` 撤销最近一次 删除/移动/覆盖,`docky restore` 从回收站还原。
- **agent 写覆盖保护**:MCP `write_doc` 默认不静默覆盖/造重复(见上),显式 `replace` 也先备份、可 `undo`。

## 作用域隔离

docky 的核心保证:所有文档操作都被限制在单一项目目录内。任何试图通过 `../` 越出项目目录的路径都会被 `safePath` 拒绝(已有单测覆盖)。agent 永远无法读到其他项目的文档;跨项目访问只能通过**显式、只读、可审计**的 `grant` 开放,且**写操作永不跨项目**。

## 中心仓库结构

```
~/docky-vault/
├── config.json                 # 全局配置(项目登记、staleDays、autocommit、grants…)
├── README.md
├── templates/<类型>.md          # 可自定义的新建模板(F06)
└── projects/<项目>/
    ├── design/  plan/  debug/  code-review/  prompts/
    │   └── *.md                # 文档真身(带 frontmatter)
    ├── INDEX.md                # 自动生成的索引
    ├── .trash/                 # 软删除回收站
    └── .docky-*.json/…         # 最近/置顶、撤销日志、历史、智能文件夹(均不入 git)
```

文档真身只存在于中心仓库;业务项目内默认不留文件。若需在项目内就地浏览,用 `docky link` 建立软链接,docky 会自动写进该项目的 `.gitignore`,保持业务 git 干净。

## 配置

vault 位置由环境变量 `DOCKY_VAULT` 决定,缺省 `~/docky-vault`。其余偏好用 `docky config` 查看/修改:

```bash
docky config                 # 列出全部可配项与当前值/默认值
docky config staleDays       # 读取
docky config set staleDays 14
```

常见键:`staleDays`(陈旧阈值,天)、`autocommit`(`auto`/`off` 等)、渲染 `width`/`theme` 等——以 `docky config` 实际输出为准。

## 开发

```bash
npm install
npm run build      # tsc -> dist/
npm test           # vitest(全量单测)
npm run dev -- list    # 用 tsx 直接跑源码 CLI
npm run mcp            # 用 tsx 直接跑 MCP 服务
```

代码结构(`src/`):`cli.ts`(CLI)· `tui.tsx`(Ink TUI)· `commands.ts`(共享命令层)· `mcp.ts` + `mcpresources.ts`(MCP)· `core.ts`(核心:作用域/检索/版本/记忆/批量…)· `config.ts` · `types.ts` · 以及 `templates / links / match / export / lint / stats / graph / savedsearch / outline / pager / importer / hooks`。

## 路线图与提案

产品提案与能力地图在 [`feature/`](./feature/) 目录:

- [`feature/00-capability-map.md`](./feature/00-capability-map.md) —— 把全部提案去重归并为约 15 个能力,标注交付状态与建议优先级。
- `feature/F01…` —— 逐条功能提案(轻量 PRD)。已交付项在文末附"实现记录"。

已落地的核心能力包括:交互检索 / 模糊快速打开 / 标签与生命周期 / 最近置顶 / 上手自愈 / 模板捕获 / agent 上下文包 / 版本化与历史 / 导入三筛 / 安全删除撤销 / 批量操作 / 智能写入覆盖保护 等;更多详见能力地图。
