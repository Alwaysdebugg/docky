<div align="center">

```
██████╗  ██████╗  ██████╗██╗  ██╗██╗   ██╗
██╔══██╗██╔═══██╗██╔════╝██║ ██╔╝╚██╗ ██╔╝
██║  ██║██║   ██║██║     █████╔╝  ╚████╔╝
██║  ██║██║   ██║██║     ██╔═██╗   ╚██╔╝
██████╔╝╚██████╔╝╚██████╗██║  ██╗   ██║
╚═════╝  ╚═════╝  ╚═════╝╚═╝  ╚═╝   ╚═╝
```

**A centralized home for the Markdown your AI agents generate — organized by project & type, decoupled from each repo's git, and served to agents with hard per-project scope isolation.**

![tests](https://img.shields.io/badge/tests-124%20passing-brightgreen)
![node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-server-7c3aed)
![license](https://img.shields.io/badge/license-MIT-blue)

CLI · MCP server

</div>

---

## Why docky?

When you build with AI coding agents, they produce a steady stream of process Markdown — principles, specs, plans, task lists, decision records, glossaries. Left in each repo, those docs:

- **pollute git** — `git diff`/`log` get buried under non-code churn;
- **scatter** — no single place to find or search history across projects;
- **pollute agent context** — an agent reads unrelated docs, wasting tokens and getting misled.

**docky** pulls these docs out of your repos into one **central vault** (its own git repo), filed as `projects/<name>/<type>/`. You browse and search from the command line; agents read and write through an MCP server that **confines every call to one project's scope** — so an agent can reuse a project's history without ever seeing another project's docs.

> docky is deliberately small: it does four things well — **search**, **agent context/memory**, **scope isolation**, and **MCP integration** — and stays out of your way.

## Features

- **Six fixed doc types, each with a review policy** — `constitution` · `spec` · `plan` · `tasks` · `adr` · `glossary`. Predictable structure for humans and machines, and an explicit answer to "how hard do I review this?" ([see below](#doc-types--review-policy)).
- **Automatic project detection** — resolves the current project from your working directory + git repo root + branch. Never falls back to a global scope.
- **Hard scope isolation** — every read/write is bounded to one project; any `../` path escape is refused (unit-tested).
- **Two interfaces** — a scriptable **CLI** and an **MCP server** for agents.
- **Relevance search** — ranked full-text search with highlighted snippets, fuzzy matching, and cross-project (granted, read-only) search.
- **One-shot agent context** — `get_context` returns a ranked, budget-bounded bundle of a project's most relevant docs.
- **Governed cross-project access** — explicit, auditable, read-only grants on top of the default full isolation.
- **Branch-scoped isolation** — optionally store docs per branch so an agent on branch A never reads branch B's docs.
- **Versioned** — the vault auto-commits on writes, so history is always recoverable from git.
- **Smart (non-duplicating) agent writes** — `write_doc` won't silently overwrite or duplicate; it returns a suggestion instead.
- **One-command Claude Code hooks** — inject the "process docs live in docky" policy and guard against stray in-repo writes.

## Doc types & review policy

Review effort is not uniform — a constitution earns a hard read once, a task list earns none. Each type carries that rule as data (`DOC_TYPE_SPECS` in `src/types.ts`), and the CLI help, the MCP tool descriptions and the `SessionStart` hook all render from that one map, so the rule an agent sees can't drift between surfaces.

| Type | Holds | Review |
|---|---|---|
| `constitution` | 项目的硬性原则与红线,长期不变 | 写的时候审透,之后几乎不看 |
| `spec` | 需求与验收标准 —— 做成什么样才算做完 | **必审(每次)** |
| `plan` | 实现方案、设计与步骤 | 抽检,重点看有没有违反 constitution |
| `tasks` | 可执行的任务清单与拆解 | 不审 —— 撞墙自然会反馈 |
| `adr` | 架构决策记录:决定了什么、为什么、代价是什么 | **必审** |
| `glossary` | 术语表:项目内统一的名词与定义 | 只审新增条目 |

The review level also orders the `get_context` bundle: what an agent must always re-read is what it should see first, so durable, authoritative docs (`constitution`/`spec`/`adr`) outrank a throwaway `tasks` list.

**Templates are opt-in.** Each type scaffolds from a built-in skeleton; docky never writes to `templates/`. Drop a `templates/<type>.md` into the vault to override one — a file there means a human put it there, so it always wins, and a built-in that later improves reaches every vault instead of being shadowed forever by a copy seeded at `init` time.

**Migrating a vault filed under the old types** — `docky migrate-types` merges `design` into `plan` and parks `debug`/`code-review`/`prompts` under `_legacy/`, inside the project (or branch) scope but outside every type dir: files and git history are kept and still greppable, docky simply stops indexing them. It handles the flat and branch-bucket layouts alike, never overwrites an occupied destination (it reports a conflict and skips), and is a **dry run unless you pass `--apply`**:

```bash
docky migrate-types                 # print the plan, touch nothing
docky migrate-types --apply         # move the files, auto-committed to the vault's git
docky migrate-types -p my-project   # scope it to one project (leaves templates alone)
```

It also clears out the templates older versions of docky seeded at `init`, which would otherwise shadow the built-ins forever — `plan.md` is the one that bites, since its seeded copy predates the taxonomy. Only files still byte-identical to what docky wrote are removed; anything you edited stays.

## Install

Requires Node ≥ 18.

```bash
git clone <your-fork-or-repo-url> docky
cd docky
npm install      # installs deps and builds (via the prepare script)
npm link         # put `docky` and `docky-mcp` on your PATH
```

Or install globally from a checkout: `npm install -g .`

## Quick start

```bash
docky setup                                      # init vault + register this repo + install hooks + show MCP hint
claude mcp add --scope user docky -- docky-mcp   # connect Claude Code (one-time)
```

That's it. Then, day to day:

```bash
docky add adr ./architecture.md          # archive a doc (project auto-detected)
docky new spec "login timeout"           # scaffold a new doc from its type template
docky list                               # browse this project's docs
docky search "session lost"              # full-text search within scope
```

## The two interfaces

### CLI

A scriptable command for every operation — archiving, creating, listing, searching, lifecycle, cross-project grants, and versioning. Run `docky --help`, or see the [command reference](#command-reference).

### MCP server

`docky-mcp` speaks the Model Context Protocol over stdio. Tools (all scope-isolated):

| Tool | Purpose |
|---|---|
| `resolve_project(cwd)` | Infer the project + branch that owns a working directory |
| `list_docs(project, type?)` | List docs within scope |
| `read_doc(project, path)` | Read one doc (e.g. `spec/x.md`); path escapes are refused |
| `search_docs(project, query, type?)` | Relevance search within scope |
| `write_doc(project, type, name, content, mode?)` | Write a doc; `mode` defaults to `new` and won't silently overwrite/duplicate |
| `get_context(project, …)` | A ranked, one-shot context bundle for the project |

It also exposes docs as MCP **resources** and provides one scaffold **prompt** per doc type (`start-spec-doc`, `start-adr-doc`, …), each carrying that type's review policy. Configure your client with:

```json
{ "mcpServers": { "docky": { "command": "docky-mcp" } } }
```

## Claude Code integration (hooks)

Make agents default to docky for process docs — one command, no scripts or `jq`:

```bash
docky hooks install          # writes ./.claude/settings.json (project-level)
docky hooks install --user   # or ~/.claude/settings.json (global)
```

It installs two idempotent hooks:

- **`SessionStart → docky hooks context`** — injects the "process docs live in docky" policy, the doc-type/review-policy table, and the current project's existing doc list, so the agent reads from the vault from the start.
- **`PreToolUse (Edit|Write) → docky hooks guard`** — blocks an agent from writing a process `.md` into the repo and redirects it to `write_doc`; standard repo docs (README/CHANGELOG/…) and vault writes are allowed.

> Hooks can only block/allow/inject — they can't force a tool call. "Read from the vault first" is driven by the injected context + your `CLAUDE.md`; the write side is enforced by the `PreToolUse` guard.

## Uninstall

`docky uninstall` reverses `setup` — it strips docky's hooks back out of Claude Code and prints the steps it can't do for you:

```bash
docky uninstall              # remove hooks from ./.claude and ~/.claude, keep the vault
docky hooks uninstall        # just the project-level hooks (mirror of `hooks install`)
docky uninstall --purge-vault --yes   # ALSO delete the vault and every doc in it (irreversible)
```

Hook removal is surgical: only docky's own entries are pulled, unrelated hooks in the same `settings.json` are left untouched. **Your vault is never deleted implicitly** — `--purge-vault` requires an explicit `--yes`. docky can't run these for you, so `uninstall` prints them: `claude mcp remove docky` and `npm rm -g docky`.

## Concepts

- **Vault** — an independent git repo (default `~/docky-vault`, override with `$DOCKY_VAULT`), laid out as `projects/<name>/<type>/`.
- **Scope isolation** — the core guarantee. All file operations are confined to a single project directory; escaping paths are rejected (`safePath`).
- **Auto-commit** — writes and deletes are committed to the vault automatically, so history is always recoverable from git.
- **Branch scope** (opt-in) — with `branchScope` on, docs live at `projects/<name>/<branch>/<type>/`; run `docky migrate-branch-scope` once to move legacy docs.
- **Git decoupling** — docs live only in the vault; your repos stay clean.

## Command reference

Run `docky --help` for the full list.

**Setup & projects** — `setup`, `uninstall`, `init`, `register`, `projects`, `whoami`
**Create & archive** — `new <type> [name]`, `add <type> <files…>`
**Find & read** — `list [type]`, `search <query>`, `open <rel>`
**Lifecycle** — `status <rel> <state>`, `mv <rel> <type>`, `rm <rel>`
**Scope & sharing** — `grant`/`revoke`/`grants`, `config`, `migrate-branch-scope`, `migrate-types`
**Versioning** — `sync`
**Agent** — `hooks install` / `hooks uninstall`

## Development

```bash
npm install
npm run build      # tsc -> dist/
npm test           # vitest (124 tests)
npm run dev -- list    # run the CLI from source via tsx
npm run mcp            # run the MCP server from source via tsx
```

## License

MIT.
