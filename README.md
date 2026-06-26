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

![tests](https://img.shields.io/badge/tests-151%20passing-brightgreen)
![node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-server-7c3aed)
![license](https://img.shields.io/badge/license-MIT-blue)

CLI · Interactive TUI · MCP server

</div>

---

## Why docky?

When you build with AI coding agents, they produce a steady stream of process Markdown — design notes, plans, debugging logs, code-review notes, prompt drafts. Left in each repo, those docs:

- **pollute git** — `git diff`/`log` get buried under non-code churn;
- **scatter** — no single place to find or search history across projects;
- **pollute agent context** — an agent reads unrelated docs, wasting tokens and getting misled.

**docky** pulls these docs out of your repos into one **central vault** (its own git repo), filed as `projects/<name>/<type>/`. Humans browse and search from a single entry point; agents read and write through an MCP server that **confines every call to one project's scope** — so an agent can reuse a project's history without ever seeing another project's docs.

## Features

- **Five fixed doc types** — `design` · `plan` · `debug` · `code-review` · `prompts`. Predictable structure for humans and machines.
- **Automatic project detection** — resolves the current project from your working directory + git repo root + branch. Never falls back to a global scope.
- **Hard scope isolation** — every read/write is bounded to one project; any `../` path escape is refused (unit-tested).
- **Three interfaces** — a CLI (~45 commands), an Ink **TUI** (Claude-Code-style REPL), and an **MCP server** for agents.
- **Search that lands you somewhere** — relevance-ranked full-text search, fuzzy quick-open, recents/pins, saved smart folders, wiki-links & backlinks.
- **Lifecycle & quality** — per-doc status (`draft/active/done/archived`), `doctor` lint, an insights `dashboard`, and a relationship `graph`.
- **Versioned & reversible** — the vault auto-commits on writes (`log`/`diff`); deletes go to a recycle bin with `undo`/`restore`.
- **Bulk import** — scan a repo for stray `.md` and classify it heuristically with a dry-run preview before anything moves.
- **First-class agent integration** — MCP tools + resources + prompts, smart (non-duplicating) writes, an agent-output review `inbox`, and one-command Claude Code hooks.

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
docky setup                              # init vault + register this repo + install hooks + show MCP hint
claude mcp add --scope user docky -- docky-mcp   # connect Claude Code (one-time)
```

That's it. Then, day to day:

```bash
docky add design ./architecture.md       # archive a doc (project auto-detected)
docky list                               # browse this project's docs
docky search "session lost"              # full-text search within scope
docky                                    # or just run `docky` for the interactive TUI
```

## The three interfaces

### CLI

A scriptable command for every operation — archiving, listing, searching, lifecycle, versioning, import, export, and more. Run `docky --help`, or see the [command reference](#command-reference).

### TUI

Run `docky` (no args) or `docky ui` for a Claude-Code-style REPL: a single command box with slash commands and a streaming output log — no panes to manage.

- Type `/` to open the **command menu** (filtered as you type); `↑/↓` to select, `Tab` to complete, `Enter` to run.
- `/list` opens a hierarchical browser (grouped by type); `↑/↓` to select, `Enter` to **preview** the rendered Markdown in your pager, `e` to open in your editor.
- `/search`, `/o` (fuzzy quick-open), `/recent`, `/dashboard`, `/graph`, `/doctor`, `/inbox`, … — `/help` lists them all.

### MCP server

`docky-mcp` speaks the Model Context Protocol over stdio. Tools (all scope-isolated):

| Tool | Purpose |
|---|---|
| `resolve_project(cwd)` | Infer the project + branch that owns a working directory |
| `list_docs(project, type?)` | List docs within scope (read the index before pulling bodies) |
| `read_doc(project, path)` | Read one doc; path escapes are refused |
| `search_docs(project, query, type?)` | Keyword search within scope |
| `write_doc(project, type, name, content, mode?)` | Write a doc; `mode` defaults to `new` and won't silently overwrite/duplicate |
| `get_context(project, …)` | A ranked, de-staled one-shot context bundle for the project |

It also exposes docs as MCP **resources** and provides scaffold **prompts** (e.g. design/debug). Configure your client with:

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

- **`SessionStart → docky hooks context`** — injects the "process docs live in docky" policy plus the current project's existing doc list, so the agent reads from the vault from the start.
- **`PreToolUse (Edit|Write) → docky hooks guard`** — blocks an agent from writing a process `.md` into the repo and redirects it to `write_doc`; standard repo docs (README/CHANGELOG/…) and vault writes are allowed.

> Hooks can only block/allow/inject — they can't force a tool call. "Read from the vault first" is driven by the injected context + your `CLAUDE.md`; the write side is enforced by the `PreToolUse` guard.

## Concepts

- **Vault** — an independent git repo (default `~/docky-vault`, override with `$DOCKY_VAULT`), laid out as `projects/<name>/<type>/`, with an auto-generated `INDEX.md` per project.
- **Scope isolation** — the core guarantee. All file operations are confined to a single project directory; escaping paths are rejected (`safePath`).
- **Auto-commit** — writes and deletes are committed to the vault automatically, so history is always recoverable.
- **Safe delete** — `rm` moves docs to a recycle bin; `undo`/`restore` bring them back.
- **Git decoupling** — docs live only in the vault; your repos stay clean. Optional `docky link` creates a symlink back into a repo and gitignores it.

## Command reference

A selection (run `docky --help` for the full list):

**Setup & projects** — `setup`, `init`, `register`, `projects`, `whoami`
**Create & archive** — `new <type>`, `add <type> <files…>`, `import [dir]`
**Find & read** — `list [type]`, `search <query>`, `open <rel>`, `links <rel>`, `recent`, `pin`/`unpin`, `save`/`folders`/`open-folder`
**Lifecycle & quality** — `status <rel> <state>`, `doctor`, `stats`, `graph`, `index`
**Versioning & safety** — `sync`, `log <rel>`, `diff <rel>`, `rm`, `undo`, `trash`, `restore`, `mv`
**Scope & sharing** — `grant`/`revoke`/`grants`, `export`, `share <rel>`, `link`/`unlink`, `config`
**Agent** — `inbox`, `review`, `hooks install`
**Interactive** — `ui` (or just `docky`)

## Development

```bash
npm install
npm run build      # tsc -> dist/
npm test           # vitest (151 tests)
npm run dev -- list    # run the CLI from source via tsx
```

## Roadmap

docky ships a large implemented feature set; the proposal index under [`feature/`](./feature) tracks what's next. Highlights on the roadmap:

- **Semantic search** (embeddings + hybrid ranking)
- **Local web UI** (`docky serve`) for browsing/reading in a browser
- **Ask Docky** — natural-language Q&A over the vault with citations
- **Agent memory layer** — durable decisions/conventions with recall
- **Team sync, multi-vault workspaces, doc↔code linking**

## License

MIT.
