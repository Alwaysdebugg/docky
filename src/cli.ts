#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import * as core from "./core.js";
import { listProjects } from "./core.js";
import { getConfigValue, getVaultPath, isInitialized, listConfig, setConfigValue } from "./config.js";
import { colorizeDiff, pageRaw, renderMarkdown } from "./pager.js";
import { extractHeadings, renderToc } from "./outline.js";
import { exportDocs, exportSite, shareDoc } from "./export.js";
import { Severity, fixProject, lintProject } from "./lint.js";
import { computeStats } from "./stats.js";
import { buildGraph, graphLines, toDot } from "./graph.js";
import { evalFolder, getFolder, listFolders, removeFolder, saveFolder } from "./savedsearch.js";
import { DOCKY_HOOK_ENTRIES, contextText, guardDecision, mergeHooks, unmergeHooks } from "./hooks.js";
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
program.enablePositionalOptions(); // lets `save` pass a query that starts with --

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
    console.log("  docky unlink -p <项目>                        # 若曾用 docky link 建过 symlink");
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
  .option("--toc", "Prepend a table of contents (F16).")
  .option("--width <n>", "Render width with reflow.")
  .option("--theme <theme>", "Render theme: dark | none.")
  .action((rel: string, opts: { project?: string; raw?: boolean; toc?: boolean; width?: string; theme?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const content = guard(() => core.readDoc(v, proj, rel));
    core.recordOpen(v, proj, rel);
    if (opts.raw) {
      console.log(content);
    } else {
      const prefs = core.renderPrefs(v);
      const theme = opts.theme === "none" ? "none" : opts.theme === "dark" ? "dark" : prefs.theme;
      let rendered = renderMarkdown(content, { width: opts.width ? Number(opts.width) : prefs.width, theme });
      if (opts.toc) {
        const toc = renderToc(extractHeadings(content));
        if (toc) rendered = `\x1b[36m目录\x1b[0m\n${toc}\n\n${"─".repeat(24)}\n\n${rendered}`;
      }
      pageRaw(rendered);
    }
  });

program
  .command("links <rel>")
  .description("Show a document's outgoing links, backlinks, and broken links (F12).")
  .option("-p, --project <name>")
  .action((rel: string, opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const links = guard(() => core.getLinks(v, proj, rel));
    const outs = links.outlinks.filter((o) => o.rel).map((o) => o.rel);
    console.log(`\x1b[36m出链 →\x1b[0m ${outs.length ? outs.join(", ") : "(none)"}`);
    console.log(`\x1b[36m被引用 ←\x1b[0m ${links.backlinks.length ? links.backlinks.join(", ") : "(none)"}`);
    if (links.broken.length) {
      console.log(`\x1b[31m⚠ broken →\x1b[0m ${links.broken.map((b) => `[[${b}]]`).join(", ")}`);
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
  .command("export")
  .description("Export project docs out of docky: --format site | html | md (F17).")
  .option("-p, --project <name>")
  .option("-t, --type <type>", "Only export this type (html/md formats).")
  .option("--format <fmt>", "site | html | md", "site")
  .option("-o, --out <dir>", "Output directory", "./docky-export")
  .action((opts: { project?: string; type?: string; format?: string; out?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const out = path.resolve(opts.out ?? "./docky-export");
    if (opts.format === "site" || !opts.format) {
      const r = guard(() => exportSite(v, proj, out));
      ok(`${r.count} 篇 → ${r.dir} (index.html + ${r.count} 页;互链已解析,徽标已渲染)`);
    } else {
      const format = opts.format === "md" ? "md" : "html";
      const r = guard(() => exportDocs(v, proj, out, { type: opts.type, format }));
      ok(`${r.count} 篇 (${format}) → ${r.dir}`);
    }
  });

program
  .command("share <rel>")
  .description("Export one document as a self-contained HTML file, ready to send (F17).")
  .option("-p, --project <name>")
  .option("-o, --out <file>", "Output file path.")
  .action((rel: string, opts: { project?: string; out?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const out = guard(() => shareDoc(v, proj, rel, opts.out));
    ok(`${out} (自包含,可直接发送)`);
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
  .command("inbox")
  .description("List agent-written documents awaiting review (review: pending) — F22.")
  .option("-p, --project <name>")
  .action((opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const pending = core.listPending(v, proj);
    if (pending.length === 0) {
      console.log("收件箱为空(无待审文档)。");
      return;
    }
    console.log(`\x1b[36m收件箱 · ${proj}\x1b[0m  (${pending.length} 篇待审)`);
    for (const d of pending) {
      console.log(`  ${d.rel}  \x1b[2m${d.source ?? "?"}\x1b[0m  ${d.title}`);
    }
  });

program
  .command("review <rel> <state>")
  .description("Set a document's review state: pending | approved (F22).")
  .option("-p, --project <name>")
  .action((rel: string, state: string, opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    guard(() => core.setReview(v, proj, rel, state));
    ok(`${rel} → review: ${state}`);
  });

program
  .command("save <name> <query...>")
  .passThroughOptions() // query tokens after <name> (e.g. --status draft) are operands
  .description('Save a named smart folder, e.g. docky save 待办 --status draft (F24).')
  .option("-p, --project <name>")
  .action((name: string, query: string[], opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const q = query.join(" ");
    guard(() => saveFolder(v, proj, name, q));
    ok(`智能文件夹「${name}」= ${q}`);
  });

program
  .command("unsave <name>")
  .description("Delete a saved smart folder.")
  .option("-p, --project <name>")
  .action((name: string, opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    guard(() => removeFolder(v, proj, name));
    ok(`已删除智能文件夹「${name}」`);
  });

program
  .command("folders")
  .description("List saved smart folders with live result counts (F24).")
  .option("-p, --project <name>")
  .action((opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const folders = listFolders(v, proj);
    if (folders.length === 0) {
      console.log("还没有智能文件夹(docky save <名称> <查询>)。");
      return;
    }
    const w = Math.max(...folders.map((f) => f.name.length), 6) + 2;
    for (const f of folders) {
      const n = evalFolder(v, proj, f.query).length;
      console.log(`  \x1b[36m${f.name.padEnd(w)}\x1b[0m${f.query.padEnd(28)}\x1b[2m(${n} 篇)\x1b[0m`);
    }
  });

program
  .command("open-folder <name>")
  .description("Evaluate a smart folder live and list its documents (F24).")
  .option("-p, --project <name>")
  .action((name: string, opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const query = getFolder(v, proj, name);
    if (query === null) fail(`没有名为「${name}」的智能文件夹。`);
    const docs = evalFolder(v, proj, query!);
    console.log(`\x1b[36m📂 ${name}\x1b[0m  \x1b[2m${query}\x1b[0m  (${docs.length} 篇)`);
    for (const d of docs) console.log(`  ${d.type.padEnd(12)} ${d.title}  \x1b[2m(${d.name})\x1b[0m`);
  });

program
  .command("graph")
  .description("Show the project's relationship graph: hubs, clusters, isolates (F23).")
  .option("-p, --project <name>")
  .option("--dot", "Output Graphviz DOT instead (for F17 / external rendering).")
  .action((opts: { project?: string; dot?: boolean }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const g = buildGraph(v, proj);
    if (opts.dot) {
      console.log(toDot(g));
      return;
    }
    console.log(`\x1b[36m${proj} · 关系图谱\x1b[0m`);
    for (const l of graphLines(g)) {
      const header = l.rel === null && /^(枢纽|簇|孤岛)/.test(l.label);
      console.log(header ? `\x1b[33m${l.label}\x1b[0m` : `  ${l.label}`);
    }
  });

program
  .command("stats")
  .alias("dashboard")
  .description("Read-only knowledge-base overview: type×status, references, tags, health (F21).")
  .option("-p, --project <name>")
  .action((opts: { project?: string }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    const s = computeStats(v, proj);
    console.log(`\x1b[36m${proj} · 概览\x1b[0m  (共 ${s.total} 篇)`);
    console.log(`${"类型".padEnd(12)}${"active".padEnd(8)}${"done".padEnd(7)}${"archived".padEnd(10)}陈旧⚠`);
    for (const t of s.byType) {
      console.log(
        `${t.type.padEnd(12)}${String(t.active).padEnd(8)}${String(t.done).padEnd(7)}${String(t.archived).padEnd(10)}${t.stale || ""}`
      );
    }
    if (s.mostReferenced.length) {
      console.log(`被引用最多  ${s.mostReferenced.map((m) => `${m.rel} (×${m.count})`).join(" · ")}`);
    }
    console.log(`孤立文档    ${s.orphans.length} 篇(无任何互链)`);
    if (s.tagHeat.length) console.log(`标签热度    ${s.tagHeat.map((t) => `#${t.tag} ${t.count}`).join(" · ")}`);
    console.log(`健康        \x1b[31m✗${s.health.error} error\x1b[0m · \x1b[33m⚠${s.health.warn} warn\x1b[0m   (docky doctor 查看)`);
  });

program
  .command("doctor")
  .alias("lint")
  .description("Health-check the project's docs; --fix applies safe repairs (F19).")
  .option("-p, --project <name>")
  .option("--fix", "Apply safe auto-fixes (add frontmatter, rebuild INDEX, commit).")
  .action((opts: { project?: string; fix?: boolean }) => {
    const v = vault();
    requireInit(v);
    const proj = resolve(v, opts.project);
    if (opts.fix) {
      const fixed = fixProject(v, proj, lintProject(v, proj));
      ok(`已自动修复 ${fixed} 项(补 frontmatter / 重建 INDEX / 提交)`);
    }
    const issues = lintProject(v, proj);
    const icon: Record<Severity, string> = { error: "\x1b[31m✗\x1b[0m", warn: "\x1b[33m⚠\x1b[0m", info: "\x1b[34mℹ\x1b[0m" };
    const w = Math.max(...issues.map((i) => (i.rel ?? "").length), 8);
    for (const i of issues) {
      console.log(`${icon[i.severity]} ${(i.rel ?? "").padEnd(w)}  ${i.message}  \x1b[2m→ ${i.fix}\x1b[0m`);
    }
    const n = (s: Severity) => issues.filter((i) => i.severity === s).length;
    const fixable = issues.filter((i) => i.fixable).length;
    if (issues.length === 0) console.log("\x1b[32m✓ 文档库健康,无问题\x1b[0m");
    else console.log(`\n汇总:${n("error")} error · ${n("warn")} warn · ${n("info")} info${fixable ? `  (--fix 可自动修 ${fixable} 项)` : ""}`);
    process.exit(n("error") > 0 ? 1 : 0);
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
    const proj = resolveBare(v, opts.project); // symlink points at the whole project dir
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
    const proj = resolveBare(v, opts.project); // symlink points at the whole project dir
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
      console.log(`branch:  ${ctx.branch ?? "-"}${core.branchScopeEnabled(v) ? " \x1b[33m(isolated · F56)\x1b[0m" : ""}`);
      if (core.branchScopeEnabled(v)) console.log(`scope:   ${core.scopedProject(v, ctx.project, ctx.branch)}`);
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
