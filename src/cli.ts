#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import * as core from "./core.js";
import { listProjects } from "./core.js";
import { getVaultPath, isInitialized } from "./config.js";
import { colorizeDiff, pageRaw, viewMarkdown } from "./pager.js";
import { DOCKY_HOOK_ENTRIES, contextText, guardDecision, mergeHooks } from "./hooks.js";
import { applyImport, planImport } from "./importer.js";
import { DOC_TYPES, DockyError } from "./types.js";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 1500); // safety timeout
  });
}

const program = new Command();

function vault(): string {
  return getVaultPath();
}

function fail(msg: string): never {
  console.error(`\x1b[31m${msg}\x1b[0m`);
  process.exit(1);
}

function requireInit(v: string): void {
  if (!isInitialized(v)) {
    fail(`Vault not initialized at ${v}. Run \`docky init\` first.`);
  }
}

/** Explicit --project wins, else auto-infer from cwd. */
function resolve(v: string, project?: string): string {
  if (project) {
    if (!(project in listProjects(v))) fail(`Unknown project: ${project}`);
    return project;
  }
  try {
    return core.resolveProject(v, process.cwd()).project;
  } catch {
    const name = core.inferRepoName(process.cwd());
    fail(`当前目录未注册到 docky。\n  → 运行:docky register ${name}      # 已按仓库名预填`);
  }
}

function ok(msg: string): void {
  console.log(`\x1b[32m${msg}\x1b[0m`);
}

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof DockyError) fail(e.message);
    throw e;
  }
}

/** Merge docky hooks into the project- or user-level Claude Code settings. */
function installHooksTo(user: boolean): { file: string; added: string[] } {
  const dir = user ? path.join(os.homedir(), ".claude") : path.join(process.cwd(), ".claude");
  const file = path.join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      fail(`现有 settings.json 不是合法 JSON,请先修复:${file}`);
    }
  }
  const { settings: merged, added } = mergeHooks(settings, DOCKY_HOOK_ENTRIES);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  return { file, added };
}

program
  .name("docky")
  .description("Centralized Markdown doc manager with per-project scope isolation.")
  .version("0.1.0");

program
  .command("setup")
  .description("One-command onboarding: init vault, register this project, install hooks, show MCP command.")
  .option("--user", "Install hooks globally (~/.claude) instead of this project.")
  .option("--name <name>", "Project name to register (default: repo/dir name).")
  .option("--no-register", "Don't register the current directory.")
  .option("--no-hooks", "Don't install hooks.")
  .action((opts: { user?: boolean; name?: string; register: boolean; hooks: boolean }) => {
    const v = vault();
    const done: string[] = [];

    // 1) vault
    if (!isInitialized(v)) {
      core.initVault(v, true);
      done.push(`初始化中心仓库 → ${v}`);
    } else {
      done.push(`中心仓库已存在 → ${v}`);
    }

    // 2) register current directory
    if (opts.register !== false) {
      const root = core.gitRoot(process.cwd()) ?? process.cwd();
      const name = opts.name ?? path.basename(root);
      guard(() => core.registerProject(v, name, root));
      done.push(`注册项目 ${name} → ${root}`);
    }

    // 3) hooks
    if (opts.hooks !== false) {
      const { file, added } = installHooksTo(Boolean(opts.user));
      done.push(added.length ? `安装 Claude Code hooks → ${file}` : `hooks 已存在 → ${file}`);
    }

    ok("docky setup 完成:");
    done.forEach((l) => console.log(`  ✓ ${l}`));

    // 4) MCP connection (must run on the user's machine; we only show it)
    console.log("\n最后一步 — 连接 agent(在你的终端执行其一):");
    console.log("  claude mcp add --scope user docky -- docky-mcp     # Claude Code,全局,推荐");
    console.log('  其他客户端配置: { "mcpServers": { "docky": { "command": "docky-mcp" } } }');
    console.log("\n完成后重启 Claude Code,用 /mcp 应能看到 docky 的工具。");
  });

program
  .command("init")
  .description("Initialize the central vault (skeleton + git repo).")
  .option("--no-git", "Skip git init.")
  .action((opts: { git: boolean }) => {
    const v = vault();
    core.initVault(v, opts.git);
    ok(`Initialized vault at ${v}`);
  });

program
  .command("register <name>")
  .description("Register a project and map a local path to it.")
  .option("--path <path>", "Local project path (defaults to current dir).")
  .option("--link", "Also create a symlink now.")
  .action((name: string, opts: { path?: string; link?: boolean }) => {
    const v = vault();
    requireInit(v);
    const p = path.resolve(opts.path ?? process.cwd());
    guard(() => {
      core.registerProject(v, name, p, Boolean(opts.link));
      if (opts.link) core.linkProject(v, name);
    });
    ok(`Registered ${name} -> ${p}`);
    if (opts.link) ok("Symlink created and added to .gitignore.");
  });

program
  .command("add <type> <files...>")
  .description(`Archive Markdown file(s) into <project>/<type>/. Types: ${DOC_TYPES.join(", ")}`)
  .option("-p, --project <name>", "Target project (auto-inferred if omitted).")
  .option("--name <name>", "Rename on archive (single file only).")
  .option("-f, --frontmatter", "Prepend metadata frontmatter.")
  .option("--force", "Overwrite an existing target (old content goes to .trash).")
  .action(
    (
      type: string,
      files: string[],
      opts: { project?: string; name?: string; frontmatter?: boolean; force?: boolean }
    ) => {
      const v = vault();
      requireInit(v);
      const proj = resolve(v, opts.project);
      const branch = core.gitBranch(process.cwd());
      if (opts.name && files.length > 1) fail("--name can only be used with a single file.");
      guard(() => {
        for (const f of files) {
          const dest = core.addDoc(v, proj, type, f, {
            branch,
            withFrontmatter: Boolean(opts.frontmatter),
            newName: opts.name,
            failIfExists: true,
            force: Boolean(opts.force),
          });
          ok(`+ ${proj}/${path.basename(path.dirname(dest))}/${path.basename(dest)}`);
        }
      });
    }
  );

program
  .command("new <type> [name]")
  .description(`Create a new document from its type template (status: draft). Types: ${DOC_TYPES.join(", ")}`)
  .option("-p, --project <name>", "Target project (auto-inferred if omitted).")
  .action((type: string, name: string | undefined, opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const dest = guard(() => core.scaffold(v, proj, type, name));
    const rel = dest.split(/[\\/]/).slice(-2).join("/");
    core.recordOpen(v, proj, rel);
    ok(`Created ${proj}/${rel}  (status: draft)`);
  });

program
  .command("list [type]")
  .description("List documents. Filter with --status/--tag/--stale; archived hidden by default.")
  .option("-p, --project <name>")
  .option("-s, --status <status>", "Filter by lifecycle status (draft|active|done|archived).")
  .option("--tag <tag>", "Filter by tag.")
  .option("--stale", "Only stale docs (active design/plan past staleDays).")
  .option("--archived", "Include archived docs.")
  .action(
    (
      type: string | undefined,
      opts: { project?: string; status?: string; tag?: string; stale?: boolean; archived?: boolean }
    ) => {
      const v = vault();
      requireInit(v);
      const proj = resolve(v, opts.project);
      const docs = guard(() =>
        core.filterDocs(core.listDocs(v, proj, type), {
          status: opts.status,
          tag: opts.tag,
          stale: Boolean(opts.stale),
          includeArchived: Boolean(opts.archived),
        })
      );
      if (docs.length === 0) {
        console.log(`No documents in project ${proj}.`);
        return;
      }
      console.log(`docky · ${proj}`);
      const w = Math.max(...docs.map((d) => d.type.length), 4);
      for (const d of docs) {
        const mark = d.stale ? "\x1b[33m⚠ \x1b[0m" : "";
        const badge = d.status !== "active" ? `\x1b[34m[${d.status}]\x1b[0m ` : "";
        const tags = d.tags.length ? `  \x1b[2m${d.tags.map((t) => `#${t}`).join(" ")}\x1b[0m` : "";
        console.log(`  ${mark}${d.type.padEnd(w)}  ${badge}${d.title}  \x1b[2m(${d.name})\x1b[0m${tags}`);
      }
    }
  );

program
  .command("status <rel> <state>")
  .description("Set a document's lifecycle status: draft | active | done | archived.")
  .option("-p, --project <name>")
  .action((rel: string, state: string, opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    guard(() => core.setStatus(v, proj, rel, state));
    ok(`${rel} -> ${state.toLowerCase()}`);
  });

program
  .command("open <rel>")
  .description("View a document, rendered, through your pager (path relative to project, e.g. design/foo.md).")
  .option("-p, --project <name>")
  .option("--raw", "Print raw Markdown instead of rendering/paging.")
  .action((rel: string, opts: { project?: string; raw?: boolean }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const content = guard(() => core.readDoc(v, proj, rel));
    core.recordOpen(v, proj, rel);
    if (opts.raw) {
      console.log(content);
    } else {
      viewMarkdown(content);
    }
  });

program
  .command("search <query>")
  .description("Search documents within the current project's scope.")
  .option("-p, --project <name>")
  .option("-t, --type <type>")
  .action((query: string, opts: { project?: string; type?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const hits = guard(() => core.searchDocs(v, proj, query, opts.type));
    if (hits.length === 0) {
      console.log(`No matches for '${query}' in ${proj}.`);
      return;
    }
    for (const h of hits) {
      const loc = h.line ? `${h.rel}:${h.line}` : h.rel;
      console.log(`\x1b[36m${loc}\x1b[0m  ${h.snippet}`);
    }
  });

program
  .command("recent")
  .description("Show recently opened and pinned documents for the project.")
  .option("-p, --project <name>")
  .action((opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const pins = core.getPins(v, proj);
    const recents = core.getRecents(v, proj);
    if (pins.length === 0 && recents.length === 0) {
      console.log(`No recents or pins in ${proj}.`);
      return;
    }
    if (pins.length) {
      console.log("\x1b[33m📌 pinned\x1b[0m");
      for (const r of pins) console.log(`  ${r}`);
    }
    if (recents.length) {
      console.log("\x1b[36m🕘 recent\x1b[0m");
      for (const r of recents) console.log(`  ${r}`);
    }
  });

program
  .command("pin <rel>")
  .description("Pin a document to the top of the homepage / quick-open.")
  .option("-p, --project <name>")
  .action((rel: string, opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    guard(() => core.pin(v, proj, rel));
    ok(`Pinned ${rel}`);
  });

program
  .command("unpin <rel>")
  .description("Remove a document from pins.")
  .option("-p, --project <name>")
  .action((rel: string, opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    guard(() => core.unpin(v, proj, rel));
    ok(`Unpinned ${rel}`);
  });

program
  .command("sync")
  .description("Commit the vault's pending changes; optionally push to a configured remote.")
  .option("--push", "Push to the configured git remote after committing.")
  .action((opts: { push?: boolean }) => {
    const v = vault();
    requireInit(v);
    const r = core.syncVault(v, Boolean(opts.push));
    if (r.committed) ok(`Committed ${r.changes} change(s)${r.pushed ? " · pushed" : ""}`);
    else console.log("Nothing to commit.");
  });

program
  .command("log <rel>")
  .description("Show a document's commit history.")
  .option("-p, --project <name>")
  .action((rel: string, opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const commits = guard(() => core.logDoc(v, proj, rel));
    if (commits.length === 0) {
      console.log(`No history for ${rel}.`);
      return;
    }
    for (const c of commits) console.log(`  \x1b[33m${c.hash}\x1b[0m  ${c.date}  ${c.subject}`);
  });

program
  .command("diff <rel> [revA] [revB]")
  .description("Show a document's diff (working tree, or between revisions), paged.")
  .option("-p, --project <name>")
  .action((rel: string, revA: string | undefined, revB: string | undefined, opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const diff = guard(() => core.diffDoc(v, proj, rel, revA, revB));
    if (!diff.trim()) {
      console.log(`No differences for ${rel}.`);
      return;
    }
    pageRaw(colorizeDiff(diff));
  });

program
  .command("index")
  .description("Generate/refresh the project's INDEX.md.")
  .option("-p, --project <name>")
  .action((opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const p = core.generateIndex(v, proj);
    ok(`Wrote ${p}`);
  });

program
  .command("link")
  .description("Create a symlink in the project repo (+ .gitignore entry).")
  .option("-p, --project <name>")
  .action((opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const link = guard(() => core.linkProject(v, proj));
    ok(`Linked ${link}`);
  });

program
  .command("unlink")
  .description("Remove the project's docs symlink.")
  .option("-p, --project <name>")
  .action((opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    guard(() => core.unlinkProject(v, proj));
    ok(`Unlinked docs for ${proj}`);
  });

program
  .command("mv <rel> <destType>")
  .description("Move a document to another type (refuses to overwrite without --force).")
  .option("--name <name>")
  .option("--force", "Overwrite an existing target (old content goes to .trash).")
  .option("-p, --project <name>")
  .action((rel: string, destType: string, opts: { name?: string; project?: string; force?: boolean }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const dest = guard(() => core.moveDoc(v, proj, rel, destType, opts.name, { force: Boolean(opts.force) }));
    ok(`Moved -> ${path.basename(path.dirname(dest))}/${path.basename(dest)}`);
  });

program
  .command("rm <rel>")
  .description("Remove a document (moved to the project's .trash; recoverable).")
  .option("-p, --project <name>")
  .option("-y, --yes", "Skip the confirmation prompt.")
  .action((rel: string, opts: { project?: string; yes?: boolean }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    if (!opts.yes) {
      console.log(`\x1b[33m⚠ 将删除 ${rel}(移入 .trash,可 docky restore)。加 --yes 确认。\x1b[0m`);
      return;
    }
    guard(() => core.removeDoc(v, proj, rel));
    ok(`Moved ${rel} to trash (docky undo / restore to recover)`);
  });

program
  .command("undo")
  .description("Undo the most recent delete / move / forced overwrite.")
  .option("-p, --project <name>")
  .action((opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    ok(guard(() => core.undo(v, proj)));
  });

program
  .command("trash")
  .description("List the project's recoverable trash entries.")
  .option("-p, --project <name>")
  .action((opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const entries = core.listTrash(v, proj);
    if (entries.length === 0) {
      console.log("Trash is empty.");
      return;
    }
    for (const e of entries) console.log(`  ${e.name}  \x1b[2m→ ${e.rel}\x1b[0m`);
  });

program
  .command("restore <name>")
  .description("Restore a document from the project's trash by its trash name.")
  .option("-p, --project <name>")
  .action((name: string, opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const rel = guard(() => core.restoreDoc(v, proj, name));
    ok(`Restored ${rel}`);
  });

program
  .command("projects")
  .description("List registered projects.")
  .action(() => {
    const v = vault();
    requireInit(v);
    const ps = listProjects(v);
    const names = Object.keys(ps);
    if (names.length === 0) {
      console.log("No projects registered.");
      return;
    }
    console.log("docky · projects");
    for (const name of names) {
      console.log(`  \x1b[1m\x1b[36m${name}\x1b[0m  ${ps[name].paths.join(", ")}  \x1b[2mlink=${ps[name].link}\x1b[0m`);
    }
  });

program
  .command("whoami")
  .description("Show which project the current working directory resolves to.")
  .action(() => {
    const v = vault();
    requireInit(v);
    try {
      const ctx = core.resolveProject(v, process.cwd());
      console.log(`project: \x1b[1m\x1b[36m${ctx.project}\x1b[0m`);
      console.log(`branch:  ${ctx.branch ?? "-"}`);
      console.log(`matched: ${ctx.root}`);
    } catch (e) {
      fail((e as Error).message);
    }
  });

program
  .command("import [dir]")
  .description("Scan a directory for stray .md files and classify them into docky (dry-run by default).")
  .option("-p, --project <name>", "Target project (auto-inferred if omitted).")
  .option("--apply", "Actually import the classified files (default is a dry-run preview).")
  .option("--move", "Move files instead of copying (implies --apply).")
  .option("-i, --interactive", "Open the interactive triage UI (per-file confirm/retype/tag/skip).")
  .option("--tags <list>", "Comma-separated tags to stamp on imported docs (writes frontmatter).")
  .action(
    async (
      dir: string | undefined,
      opts: { project?: string; apply?: boolean; move?: boolean; interactive?: boolean; tags?: string }
    ) => {
      const v = vault();
      requireInit(v);
      const proj = resolve(v, opts.project);
      const targetDir = path.resolve(dir ?? process.cwd());
      const tags = opts.tags ? opts.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];

      if (opts.interactive) {
        const { runTui, detectProject } = await import("./tui.js");
        runTui(v, detectProject(v) ?? proj, { dir: targetDir, tags });
        return;
      }
      const items = planImport(targetDir, v);

    if (items.length === 0) {
      console.log(`未在 ${targetDir} 找到可导入的 .md。`);
      return;
    }

    // dry-run table: source (relative) | type | confidence | reason
    const rel = (p: string) => path.relative(targetDir, p) || path.basename(p);
    const wSrc = Math.min(Math.max(...items.map((i) => rel(i.src).length), 6), 50);
    const conf: Record<string, string> = { high: "高", medium: "中", none: "—" };
    const sorted = [...items].sort((a, b) => (a.type === null ? 1 : 0) - (b.type === null ? 1 : 0));
    console.log(`docky import · 项目 ${proj} · 扫描 ${targetDir}`);
    console.log(`  ${"文件".padEnd(wSrc)}  ${"类型".padEnd(12)}  置信  理由`);
    for (const it of sorted) {
      const t = it.type ?? "(未分类)";
      console.log(`  ${rel(it.src).padEnd(wSrc)}  ${t.padEnd(12)}  ${conf[it.confidence].padEnd(3)}  ${it.reason}`);
    }
    const classified = items.filter((i) => i.type);
    const unclassified = items.length - classified.length;
    console.log(`\n共 ${items.length} 篇:可归类 ${classified.length},未分类 ${unclassified}(未分类不会导入)。`);

    if (!opts.apply && !opts.move) {
      console.log("这是预览(dry-run)。确认无误后加 --apply 执行,或 --move 移动原文件。");
      return;
    }
    const results = guard(() =>
      applyImport(v, proj, tags.length ? classified.map((c) => ({ ...c, tags })) : classified, {
        move: Boolean(opts.move),
        frontmatter: tags.length > 0,
      })
    );
    ok(`\n已${opts.move ? "移动" : "复制"} ${results.length} 篇到 ${proj}${tags.length ? ` (#${tags.join(" #")})` : ""}:`);
    for (const r of results) console.log(`  + ${r.type}/${path.basename(r.dest)}`);
    if (unclassified > 0) console.log(`(${unclassified} 篇未分类已跳过,可手动 docky add 或加 frontmatter 后重试)`);
  });

// ---- Claude Code hook integration ---- //
const hooks = program.command("hooks").description("Claude Code hook integration (install + handlers).");

hooks
  .command("install")
  .description("Install docky hooks into Claude Code settings (project by default).")
  .option("--user", "Write to ~/.claude/settings.json instead of ./.claude/settings.json.")
  .action((opts: { user?: boolean }) => {
    const { file, added } = installHooksTo(Boolean(opts.user));
    if (added.length === 0) {
      ok(`docky hooks 已存在,无需改动:${file}`);
    } else {
      ok(`已写入 docky hooks → ${file}`);
      added.forEach((a) => console.log(`  + ${a}`));
    }
  });

// PreToolUse handler: reads the hook JSON from stdin, may deny markdown writes.
hooks
  .command("guard")
  .description("(internal) PreToolUse handler invoked by Claude Code.")
  .action(async () => {
    const input = await readStdin();
    const out = guardDecision(input, vault());
    if (out) console.log(out);
  });

// SessionStart handler: prints policy + current project's docs as context.
hooks
  .command("context")
  .description("(internal) SessionStart handler invoked by Claude Code.")
  .action(() => {
    const v = vault();
    console.log(contextText(v, process.cwd(), isInitialized(v)));
  });

async function launchTui(): Promise<void> {
  const v = vault();
  // No requireInit: an uninitialized vault is not a dead-end — the TUI shows a
  // one-key "create vault" onboarding card instead of a hard error (F05).
  const { runTui, detectProject } = await import("./tui.js");
  runTui(v, detectProject(v));
}

program
  .command("ui")
  .description("Launch the interactive TUI.")
  .action(launchTui);

// Bare `docky` (no subcommand) launches the interactive TUI.
if (process.argv.slice(2).length === 0) {
  launchTui();
} else {
  program.parseAsync(process.argv);
}
