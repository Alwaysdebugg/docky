# docky (TypeScript)

集中管理 AI agent 辅助开发时产生的各类 Markdown 文档,按 `项目 / 类型` 分类,与各业务项目的 git 解耦,并对 agent 强制**按项目作用域隔离**读取。

TypeScript 实现:`commander`(CLI)+ 官方 `@modelcontextprotocol/sdk`(MCP)+ `Ink`(TUI)。

## 安装

本地开发(editable 风格,改代码即生效):

```bash
cd docky-ts
npm install            # 安装依赖并自动 build
npm link               # 把 docky / docky-mcp 挂到全局
```

或构建后全局安装:

```bash
npm install && npm run build
npm install -g .
```

> 用 Node 分发,无需处理 Python 的 PEP 668 / pipx 问题。也可 `npx` 直接跑。

## 概念

- **中心仓库(vault)**:独立 git 仓库,默认 `~/docky-vault`,可用环境变量 `DOCKY_VAULT` 覆盖。结构 `projects/<项目>/<类型>/`。
- **类型(固定枚举)**:`design`、`plan`、`debug`、`code-review`、`prompts`。
- **项目自动识别**:命令在某项目目录下运行时,按"工作目录 + git 仓库根 + 当前 branch"自动推断属于哪个项目;推断失败则报错,绝不静默回退到全局。

## 快速上手

```bash
docky init                       # 初始化中心仓库
cd ~/code/my-app
docky register my-app            # 注册当前目录为项目 my-app
docky whoami                     # 确认当前目录解析到的项目/分支

docky add design ./架构.md       # 归档(自动判定项目)
docky add debug ./排查.md -f     # -f 自动加 frontmatter
docky list                       # 列出当前项目全部文档
docky list debug                 # 只看 debug
docky search session             # 作用域内检索
docky index                      # 刷新 INDEX.md
```

## CLI 命令

| 命令 | 说明 |
|---|---|
| `docky init [--no-git]` | 初始化中心仓库 |
| `docky register <名> [--path P] [--link]` | 注册项目并登记本地路径 |
| `docky add <类型> <文件...> [-p 项目] [-f] [--name N]` | 归档文档 |
| `docky list [类型] [-p 项目]` | 列出文档 |
| `docky open <相对路径> [-p 项目] [--raw]` | 渲染后用分页器查看文档(`--raw` 输出原始 md) |
| `docky search <关键词> [-p 项目] [-t 类型]` | 作用域内检索 |
| `docky index [-p 项目]` | 生成/刷新 INDEX.md |
| `docky link / unlink [-p 项目]` | 在项目内建立/移除 symlink(并维护 .gitignore) |
| `docky mv <相对路径> <目标类型> [--name N]` | 移动文档到另一类型 |
| `docky rm <相对路径> [-p 项目]` | 删除文档 |
| `docky projects` / `docky whoami` | 查看项目 / 当前作用域 |

`-p/--project` 省略时一律自动推断当前项目。

## TUI(交互界面)

直接运行 `docky`(不带参数)或 `docky ui` 进入交互界面。仿 Claude Code 的单输入框 REPL,**没有分栏**:命令结果从上往下流式打印,底部一个命令输入框。

```
docky
```

- 输入 `/` 弹出**全部命令菜单**(随输入实时过滤),菜单右侧说明右对齐。
- 用 `↑/↓` 在菜单里选择,`Tab` 补全,`Enter` 执行高亮命令(需要参数的命令会先填入等你补参数)。
- 命令开头的 `/` 可带可不带,回车执行,结果打印在上方。
- 进入时自动按当前目录推断项目;`/use <项目>` 切换作用域。

界面内命令:

| 命令 | 说明 |
|---|---|
| `/help` | 列出全部命令 |
| `/init [项目名] [路径]` | 把当前仓库登记为项目(默认用仓库名)并切换;`/register` 为别名 |
| `/projects` | 进入项目选择器(↑/↓ 选择,Enter 切换到该项目,Esc/q 返回) |
| `/use <项目>` / `/whoami` | 直接切换 / 识别当前项目 |
| `/list [类型]` | 进入层级文档浏览器(按类型分组、显示文件名;↑/↓ 选择,Enter 用默认应用打开,Esc/q 返回) |
| `/search <关键词>` | 作用域内全文检索 |
| `/open <相对路径>` | 渲染 md 并在同终端分页器中查看(按 q 返回 docky) |
| `/add <类型> <路径> [名]` | 归档 md |
| `/index` | 刷新 INDEX.md |
| `/mv <相对路径> <类型>` / `/rm <相对路径>` | 移动 / 删除 |
| `/link` / `/unlink` | 建立 / 移除 symlink |
| `/clear` / `/exit` | 清屏 / 退出(`/quit` 为别名) |

所有命令都被限制在当前项目作用域内。

`/open` 与 `docky open` 会把 Markdown 渲染成带颜色的终端文本,并用你的分页器($PAGER,默认 `less -R`)在**同一个终端**打开——无需切换到别的应用,按 `q` 即返回 docky。

## MCP(给 AI agent 用)

启动(stdio):

```bash
docky-mcp            # 或 node dist/mcp.js / npm run mcp
```

MCP 客户端配置:

```json
{
  "mcpServers": {
    "docky": { "command": "docky-mcp" }
  }
}
```

提供的工具(全部按 `project` 作用域隔离,越界路径一律拒绝):

| 工具 | 用途 |
|---|---|
| `resolve_project(cwd)` | 由工作目录推断项目与分支 |
| `list_docs(project, type?)` | 列出作用域内文档(建议先列再读) |
| `read_doc(project, path)` | 读取单篇,路径越界拒绝 |
| `search_docs(project, query, type?)` | 作用域内关键词检索 |
| `write_doc(project, type, name, content)` | 写入文档 |

## 作用域隔离

docky 的核心保证:所有文档操作都被限制在单一项目目录内,任何试图通过 `../` 越出项目目录的路径都会被 `safePath` 拒绝(已有单测覆盖)。agent 永远无法读到其他项目的文档。

## 开发

```bash
npm install
npm run build      # tsc -> dist/
npm test           # vitest
npm run dev -- list    # 用 tsx 直接跑源码
```

## 与业务 git 解耦

文档真身只存在于中心仓库;业务项目内默认不留文件。若需在项目内就地浏览,用 `docky link` 建立软链接,docky 会自动把它写进该项目的 `.gitignore`,保持业务 git 干净。symlink 默认关闭。

## 路线图

- [x] TUI(Ink):Claude-Code 式单框 REPL + 斜杠命令菜单,裸 `docky` 启动
- [ ] `docky import`:存量 md 批量接管(扫描/分类/移动/gitignore)
