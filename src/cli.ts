#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import * as core from "./core.js";
import { listProjects } from "./core.js";
import { getVaultPath, isInitialized } from "./config.js";
import { viewMarkdown } from "./pager.js";
import { DOCKY_HOOK_ENTRIES, contextText, guardDecision, mergeHooks } from "./hooks.js";
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
  } catch (e) {
    fail((e as Error).message);
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

program
  .name("docky")
  .description("Centralized Markdown doc manager with per-project scope isolation.")
  .version("0.1.0");

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
  .action((type: string, files: string[], opts: { project?: string; name?: string; frontmatter?: boolean }) => {
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
        });
        ok(`+ ${proj}/${path.basename(path.dirname(dest))}/${path.basename(dest)}`);
      }
    });
  });

program
  .command("list [type]")
  .description("List documents for a project (auto-inferred if not given).")
  .option("-p, --project <name>")
  .action((type: string | undefined, opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const docs = guard(() => core.listDocs(v, proj, type));
    if (docs.length === 0) {
      console.log(`No documents in project ${proj}.`);
      return;
    }
    console.log(`docky · ${proj}`);
    const w = Math.max(...docs.map((d) => d.type.length), 4);
    for (const d of docs) {
      console.log(`  ${d.type.padEnd(w)}  ${d.title}  \x1b[2m(${d.name})\x1b[0m`);
    }
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
  .description("Move a document to another type.")
  .option("--name <name>")
  .option("-p, --project <name>")
  .action((rel: string, destType: string, opts: { name?: string; project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const dest = guard(() => core.moveDoc(v, proj, rel, destType, opts.name));
    ok(`Moved -> ${path.basename(path.dirname(dest))}/${path.basename(dest)}`);
  });

program
  .command("rm <rel>")
  .description("Remove a document.")
  .option("-p, --project <name>")
  .action((rel: string, opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    guard(() => core.removeDoc(v, proj, rel));
    ok(`Removed ${rel}`);
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

// ---- Claude Code hook integration ---- //
const hooks = program.command("hooks").description("Claude Code hook integration (install + handlers).");

hooks
  .command("install")
  .description("Install docky hooks into Claude Code settings (project by default).")
  .option("--user", "Write to ~/.claude/settings.json instead of ./.claude/settings.json.")
  .action((opts: { user?: boolean }) => {
    const dir = opts.user
      ? path.join(os.homedir(), ".claude")
      : path.join(process.cwd(), ".claude");
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
  requireInit(v);
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
