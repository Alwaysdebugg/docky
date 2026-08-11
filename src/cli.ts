#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import * as core from "./core.js";
import { listProjects } from "./core.js";
import { getConfigValue, getVaultPath, isInitialized, listConfig, setConfigValue } from "./config.js";
import { pageRaw, renderMarkdown } from "./pager.js";
import { DOCKY_HOOK_ENTRIES, contextText, guardDecision, mergeHooks, unmergeHooks } from "./hooks.js";
import { DOC_TYPES, DockyError, docTypeCatalog } from "./types.js";

/** The doc taxonomy + its review policy, appended to type-taking commands' help. */
const TYPES_HELP = `\n文档类型与审查强度:\n${docTypeCatalog("  ").join("\n")}\n`;

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
program.enablePositionalOptions();

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

/** Bare project name. Explicit --project wins, else auto-infer from cwd. */
function resolveBare(v: string, project?: string): string {
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

/**
 * Branch-scoped project key for filesystem ops (F56). When branchScope is on it
 * returns "<project>/<branch>" (branch from cwd's git); otherwise the bare name,
 * so every command that uses this is unchanged when the flag is off. Config /
 * cross-project commands (grant/revoke/search --across) use resolveBare instead.
 */
function resolve(v: string, project?: string): string {
  return core.scopedProject(v, resolveBare(v, project), core.gitBranch(process.cwd()));
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

/** Remove docky hooks from the project- or user-level Claude Code settings.
 *  `existed` is false when there is no settings.json to touch. */
function uninstallHooksFrom(user: boolean): { file: string; removed: string[]; existed: boolean } {
  const dir = user ? path.join(os.homedir(), ".claude") : path.join(process.cwd(), ".claude");
  const file = path.join(dir, "settings.json");
  if (!fs.existsSync(file)) return { file, removed: [], existed: false };
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    fail(`现有 settings.json 不是合法 JSON,请先修复:${file}`);
  }
  const { settings: pruned, removed } = unmergeHooks(settings, DOCKY_HOOK_ENTRIES);
  if (removed.length) fs.writeFileSync(file, JSON.stringify(pruned, null, 2) + "\n", "utf-8");
  return { file, removed, existed: true };
}

program
  .name("docky")
  .description("Centralized Markdown doc manager with per-project scope isolation (CLI + MCP).")
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
  .command("uninstall")
  .description(
    "Undo docky's Claude Code integration: remove its hooks and print the remaining " +
      "manual steps. Your vault (all your docs) is PRESERVED unless --purge-vault."
  )
  .option("--user", "Only touch user-level ~/.claude.")
  .option("--project", "Only touch project-level ./.claude.")
  .option("--purge-vault", "ALSO delete the vault directory and every document in it (destructive).")
  .option("-y, --yes", "Confirm --purge-vault without the extra warning.")
  .action((opts: { user?: boolean; project?: boolean; purgeVault?: boolean; yes?: boolean }) => {
    const v = vault();

    // 1) hooks — both scopes by default; --user / --project narrows it.
    const scopes: boolean[] = opts.user ? [true] : opts.project ? [false] : [false, true];
    const done: string[] = [];
    for (const userScope of scopes) {
      const { file, removed, existed } = uninstallHooksFrom(userScope);
      if (existed && removed.length) done.push(`移除 hooks ← ${file}(${removed.length} 条)`);
    }
    if (done.length === 0) console.log("未发现已安装的 docky hooks。");
    else {
      ok("已卸载 docky 集成:");
      done.forEach((l) => console.log(`  ✓ ${l}`));
    }

    // 2) vault — never deleted implicitly; --purge-vault + confirmation only.
    if (opts.purgeVault) {
      if (!opts.yes) {
        console.log(
          `\n\x1b[33m⚠ --purge-vault 将永久删除 ${v} 及其中所有文档,不可恢复。确认请加 --yes。\x1b[0m`
        );
      } else if (fs.existsSync(v)) {
        fs.rmSync(v, { recursive: true, force: true });
        ok(`已删除 vault → ${v}`);
      } else {
        console.log(`vault 不存在:${v}`);
      }
    }

    // 3) steps docky cannot perform itself.
    console.log("\n还需手动完成(docky 无法代劳):");
    console.log("  claude mcp remove docky                       # 断开 Claude Code 的 MCP 连接");
    console.log("  npm rm -g docky   (或 npm unlink -g docky)    # 从 PATH 移除 docky / docky-mcp");
    if (!opts.purgeVault) {
      console.log(`  rm -rf ${v}    # 如需连同全部文档一并删除(或 docky uninstall --purge-vault --yes)`);
    }
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
  .action((name: string, opts: { path?: string }) => {
    const v = vault();
    requireInit(v);
    const p = path.resolve(opts.path ?? process.cwd());
    guard(() => core.registerProject(v, name, p));
    ok(`Registered ${name} -> ${p}`);
  });

program
  .command("add <type> <files...>")
  .description(`Archive Markdown file(s) into <project>/<type>/. Types: ${DOC_TYPES.join(", ")}`)
  .addHelpText("after", TYPES_HELP)
  .option("-p, --project <name>", "Target project (auto-inferred if omitted).")
  .option("--name <name>", "Rename on archive (single file only).")
  .option("-f, --frontmatter", "Prepend metadata frontmatter.")
  .option("--force", "Overwrite an existing target (prior version kept in git history when autocommit is on).")
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
  .addHelpText("after", TYPES_HELP)
  .option("-p, --project <name>", "Target project (auto-inferred if omitted).")
  .action((type: string, name: string | undefined, opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const dest = guard(() => core.scaffold(v, proj, type, name));
    const rel = dest.split(/[\\/]/).slice(-2).join("/");
    ok(`Created ${proj}/${rel}  (status: draft)`);
  });

program
  .command("list [type]")
  .description("List documents. Filter with --status/--tag; archived hidden by default.")
  .option("-p, --project <name>")
  .option("-s, --status <status>", "Filter by lifecycle status (draft|active|done|archived).")
  .option("--tag <tag>", "Filter by tag.")
  .option("--archived", "Include archived docs.")
  .action(
    (type: string | undefined, opts: { project?: string; status?: string; tag?: string; archived?: boolean }) => {
      const v = vault();
      requireInit(v);
      const proj = resolve(v, opts.project);
      const docs = guard(() =>
        core.filterDocs(core.listDocs(v, proj, type), {
          status: opts.status,
          tag: opts.tag,
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
        const badge = d.status !== "active" ? `\x1b[34m[${d.status}]\x1b[0m ` : "";
        const tags = d.tags.length ? `  \x1b[2m${d.tags.map((t) => `#${t}`).join(" ")}\x1b[0m` : "";
        console.log(`  ${d.type.padEnd(w)}  ${badge}${d.title}  \x1b[2m(${d.name})\x1b[0m${tags}`);
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
  .description("View a document, rendered, through your pager (path relative to project, e.g. spec/foo.md).")
  .option("-p, --project <name>")
  .option("--raw", "Print raw Markdown instead of rendering/paging.")
  .option("--width <n>", "Render width with reflow.")
  .option("--theme <theme>", "Render theme: dark | none.")
  .action((rel: string, opts: { project?: string; raw?: boolean; width?: string; theme?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const content = guard(() => core.readDoc(v, proj, rel));
    if (opts.raw) {
      console.log(content);
    } else {
      const prefs = core.renderPrefs(v);
      const theme = opts.theme === "none" ? "none" : opts.theme === "dark" ? "dark" : prefs.theme;
      pageRaw(renderMarkdown(content, { width: opts.width ? Number(opts.width) : prefs.width, theme }));
    }
  });

program
  .command("search <query>")
  .description("Search documents (relevance-ranked, multi-snippet, highlighted).")
  .option("-p, --project <name>")
  .option("-t, --type <type>")
  .option("--fuzzy", "Fuzzy (subsequence) matching via match.ts.")
  .option("--across", "Include granted (read-only) cross-project scopes (F15).")
  .action((query: string, opts: { project?: string; type?: string; fuzzy?: boolean; across?: boolean }) => {
    const v = vault();
    requireInit(v);
    const bare = resolveBare(v, opts.project);
    const branch = core.gitBranch(process.cwd());
    if (opts.across) {
      // Cross-project search resolves grants by bare name; each scope searched in its own branch (F56).
      const hits = guard(() => core.searchAcross(v, bare, query, { type: opts.type, fuzzy: Boolean(opts.fuzzy), branch }));
      if (hits.length === 0) {
        console.log(`No matches for '${query}'.`);
        return;
      }
      for (const h of hits) {
        const tag = h.readonly ? `[${h.project}↗]` : `[${h.project}]`;
        console.log(`\x1b[33m★${h.score}\x1b[0m \x1b[36m${tag} ${h.rel}\x1b[0m`);
        for (const s of h.snippets) console.log(`    ${s.line ? `L${s.line} ` : ""}${s.text}`);
      }
      return;
    }
    const proj = core.scopedProject(v, bare, branch);
    const hits = guard(() => core.searchDocs(v, proj, query, opts.type, {}, { fuzzy: Boolean(opts.fuzzy) }));
    if (hits.length === 0) {
      console.log(`No matches for '${query}' in ${proj}.`);
      return;
    }
    for (const h of hits) {
      console.log(`\x1b[33m★${h.score}\x1b[0m \x1b[36m${h.rel}\x1b[0m`);
      for (const s of h.snippets) console.log(`    ${s.line ? `L${s.line} ` : ""}${s.text}`);
    }
  });

program
  .command("grant <target>")
  .description("Grant this project read-only access to <other> or <other:type> (F15).")
  .option("-p, --project <name>")
  .action((target: string, opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolveBare(v, opts.project); // grants are project-level, not branch-scoped
    guard(() => core.addGrant(v, proj, target));
    ok(`Granted ${proj} → ${target} (read-only)`);
  });

program
  .command("revoke <target>")
  .description("Revoke a cross-project read-only grant.")
  .option("-p, --project <name>")
  .action((target: string, opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolveBare(v, opts.project); // grants are project-level, not branch-scoped
    guard(() => core.revokeGrant(v, proj, target));
    ok(`Revoked ${proj} → ${target}`);
  });

program
  .command("grants")
  .description("List cross-project read-only grants (audit).")
  .action(() => {
    const v = vault();
    requireInit(v);
    const entries = Object.entries(core.listGrants(v)).filter(([, l]) => l.length > 0);
    if (entries.length === 0) {
      console.log("No cross-project grants (full isolation).");
      return;
    }
    for (const [proj, list] of entries) {
      console.log(`  \x1b[36m${proj}\x1b[0m  →  ${list.map((t) => `${t} (只读↗)`).join(", ")}`);
    }
  });

program
  .command("migrate-branch-scope")
  .description("F56: move a project's legacy docs into a branch bucket projects/<name>/<branch>/.")
  .option("-p, --project <name>")
  .option("-b, --branch <branch>", "Target branch bucket (default: current git branch).")
  .action((opts: { project?: string; branch?: string }) => {
    const v = vault();
    requireInit(v);
    if (!core.branchScopeEnabled(v)) {
      console.log("提示:branchScope 尚未开启 —— 先 `docky config set branchScope true` 再迁移。");
    }
    const proj = resolveBare(v, opts.project);
    const branch = opts.branch ?? core.gitBranch(process.cwd());
    const r = guard(() => core.migrateBranchScope(v, proj, branch));
    if (r.moved.length === 0) {
      ok(`${proj}: 无需迁移(已在分支桶 ${r.bucket} 或无遗留文档)`);
    } else {
      ok(`已迁移 ${proj} → ${r.bucket}/(${r.moved.length} 项: ${r.moved.join(", ")})`);
    }
  });

program
  .command("migrate-types")
  .description("Relocate docs filed under a retired doc type (design→plan; debug/code-review/prompts→_legacy/). Dry-run unless --apply.")
  .option("-p, --project <name>", "Only this project (default: every project in the vault; templates are left alone).")
  .option("--apply", "Actually move the files (default: print the plan and touch nothing).")
  .action((opts: { project?: string; apply?: boolean }) => {
    const v = vault();
    requireInit(v);
    const r = guard(() => core.migrateTypes(v, { project: opts.project, apply: Boolean(opts.apply) }));

    if (r.moves.length === 0 && r.conflicts.length === 0 && r.pruned.length === 0 && r.templates.length === 0) {
      ok("没有需要迁移的旧类型文档。");
      return;
    }
    const byScope = new Map<string, core.TypeMove[]>();
    for (const m of r.moves) byScope.set(m.scope, [...(byScope.get(m.scope) ?? []), m]);
    for (const [scope, list] of byScope) {
      console.log(`\x1b[36m${scope}\x1b[0m`);
      for (const m of list) console.log(`  ${m.from}  →  ${m.to}`);
    }
    if (r.conflicts.length) {
      console.log(`\n\x1b[33m跳过(目标已存在,不覆盖):\x1b[0m`);
      for (const c of r.conflicts) console.log(`  ${c.scope}/${c.from}  ✗  ${c.to}`);
    }
    if (r.pruned.length) console.log(`\n清理空目录: ${r.pruned.length} 个`);
    if (r.templates.length) {
      console.log(`\n\x1b[2m陈旧模板(docky 自己种下的,删掉即回落到内置模板):\x1b[0m`);
      for (const t of r.templates) console.log(`  templates/${t}`);
    }

    const tail = `${r.moves.length} 篇待迁移${r.conflicts.length ? `,${r.conflicts.length} 篇冲突跳过` : ""}`;
    if (r.applied) ok(`\n已迁移 ${r.moves.length} 篇${r.conflicts.length ? `(${r.conflicts.length} 篇冲突跳过)` : ""}。`);
    else console.log(`\n\x1b[2m(dry-run)\x1b[0m ${tail} —— 确认无误后加 --apply 执行。`);
  })
  .addHelpText(
    "after",
    "\n_legacy/ 位于项目(或分支桶)目录下、所有类型目录之外:文件与 git 历史保留,但 docky 的 list/search/get_context 不再索引它们。\n" +
      "\ntemplates/ 是纯 opt-in 覆盖层,docky 不再往里写东西。早期版本在 init 时种过一批模板,其中 plan.md 会一直遮住更新后的内置模板 —— 本命令会删掉这些逐字节未改动的种子文件;你改过的模板一律不动。\n"
  );

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
  .command("config [arg1] [arg2] [arg3]")
  .description("View or change preferences. No args = list; <key> = get; <key> <value> = set (F18).")
  .action((arg1: string | undefined, arg2: string | undefined, arg3: string | undefined) => {
    const v = vault();
    requireInit(v);
    // Support both `config <key> [value]` and `config get|set <key> [value]`.
    let action: "list" | "get" | "set";
    let key: string | undefined;
    let value: string | undefined;
    if (arg1 === undefined) action = "list";
    else if (arg1 === "get" || arg1 === "set") {
      action = arg1;
      key = arg2;
      value = arg3;
    } else {
      key = arg1;
      value = arg2;
      action = value === undefined ? "get" : "set";
    }

    if (action === "list") {
      console.log(`vault         ${v}`);
      for (const r of listConfig(v)) {
        const def = r.value === r.default ? "" : ` \x1b[2m(默认 ${r.default})\x1b[0m`;
        console.log(`${r.key.padEnd(14)}${r.value.padEnd(10)}\x1b[2m${r.desc}\x1b[0m${def}`);
      }
      return;
    }
    if (!key) fail("用法: docky config [<key> [value]] | get <key> | set <key> <value>");
    if (action === "get") {
      console.log(guard(() => getConfigValue(v, key!)));
      return;
    }
    if (value === undefined) fail(`用法: docky config set ${key} <value>`);
    guard(() => setConfigValue(v, key!, value!));
    ok(`${key} = ${value}`);
  });

program
  .command("mv <rel> <destType>")
  .description("Move a document to another type (refuses to overwrite without --force).")
  .option("--name <name>")
  .option("--force", "Overwrite an existing target (prior version kept in git history when autocommit is on).")
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
  .description("Remove a document (auto-committed to the vault's git history when autocommit is on).")
  .option("-p, --project <name>")
  .option("-y, --yes", "Skip the confirmation prompt.")
  .action((rel: string, opts: { project?: string; yes?: boolean }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    if (!opts.yes) {
      console.log(`\x1b[33m⚠ 将删除 ${rel}。加 --yes 确认。\x1b[0m`);
      return;
    }
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
      console.log(`  \x1b[1m\x1b[36m${name}\x1b[0m  ${ps[name].paths.join(", ")}`);
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
      console.log(`branch:  ${ctx.branch ?? "-"}${core.branchScopeEnabled(v) ? " \x1b[33m(isolated · F56)\x1b[0m" : ""}`);
      if (core.branchScopeEnabled(v)) console.log(`scope:   ${core.scopedProject(v, ctx.project, ctx.branch)}`);
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
    const { file, added } = installHooksTo(Boolean(opts.user));
    if (added.length === 0) {
      ok(`docky hooks 已存在,无需改动:${file}`);
    } else {
      ok(`已写入 docky hooks → ${file}`);
      added.forEach((a) => console.log(`  + ${a}`));
    }
  });

hooks
  .command("uninstall")
  .description("Remove docky hooks from Claude Code settings (project by default).")
  .option("--user", "Remove from ~/.claude/settings.json instead of ./.claude/settings.json.")
  .action((opts: { user?: boolean }) => {
    const { file, removed, existed } = uninstallHooksFrom(Boolean(opts.user));
    if (!existed) {
      console.log(`未找到 settings.json:${file}(无需卸载)`);
      return;
    }
    if (removed.length === 0) {
      ok(`未发现 docky hooks,无需改动:${file}`);
    } else {
      ok(`已移除 docky hooks ← ${file}`);
      removed.forEach((r) => console.log(`  - ${r}`));
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

// Bare `docky` (no subcommand) prints help — the interactive surface is the MCP server.
if (process.argv.slice(2).length === 0) {
  program.outputHelp();
} else {
  program.parseAsync(process.argv);
}
