/**
 * docky TUI — a Claude-Code-style REPL built with Ink.
 *
 * Single command input at the bottom; results stream above it. Type `/` to see
 * the full command menu (filtered as you type); Tab completes. No panes.
 */
import fs from "node:fs";
import path from "node:path";
import React, { useEffect, useState } from "react";
import { Box, Static, Text, render, useApp, useInput, useStdin, useStdout } from "ink";
import TextInput from "ink-text-input";
import { OutLine, executeCommand, parseListArgs, suggest } from "./commands.js";
import * as core from "./core.js";
import { DocInfo, DOC_TYPES, DockyError, SearchHit } from "./types.js";
import { colorizeDiff, openExternally, renderMarkdown, spawnPager } from "./pager.js";
import { fuzzy } from "./match.js";
import { Confidence, applyImport, planImport } from "./importer.js";
import { SelectableItem, SelectableList } from "./components/SelectableList.js";

function colorOf(level: OutLine["level"]): string | undefined {
  switch (level) {
    case "in":
      return "gray";
    case "info":
      return "cyan";
    case "err":
      return "red";
    case "ok":
      return "green";
    default:
      return undefined;
  }
}

type HistItem = OutLine & { key: number; banner?: boolean };

function welcomeItems(): Array<OutLine & { banner?: boolean }> {
  return [{ text: "", level: "info", banner: true }];
}

// oh-my-logo style ASCII wordmark (ANSI Shadow font) for "DOCKY".
const LOGO = [
  "██████╗  ██████╗  ██████╗██╗  ██╗██╗   ██╗",
  "██╔══██╗██╔═══██╗██╔════╝██║ ██╔╝╚██╗ ██╔╝",
  "██║  ██║██║   ██║██║     █████╔╝  ╚████╔╝ ",
  "██║  ██║██║   ██║██║     ██╔═██╗   ╚██╔╝  ",
  "██████╔╝╚██████╔╝╚██████╗██║  ██╗   ██║   ",
  "╚═════╝  ╚═════╝  ╚═════╝╚═╝  ╚═╝   ╚═╝   ",
];
// Top-to-bottom gradient (cyan → purple), like oh-my-logo.
const GRADIENT = ["#00d7ff", "#27b6e6", "#5f93f0", "#8f6def", "#b35cef", "#d75fff"];

/** oh-my-logo style welcome wordmark. */
function Banner() {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {LOGO.map((l, i) => (
        <Text key={i} bold color={GRADIENT[i]}>
          {l}
        </Text>
      ))}
      <Text dimColor>Docky · 文档管理 · 输入 / 看命令 · /help 帮助 · /exit 退出</Text>
    </Box>
  );
}

export interface AppProps {
  vault: string;
  initialProject: string | null;
  /** When set, the TUI enters import triage for this directory on mount (F09). */
  initialImport?: { dir: string; tags?: string[] };
}

interface TriageItem {
  src: string;
  rel: string;
  type: string | null;
  confidence: Confidence;
  reason: string;
  selected: boolean;
}

let LINE_KEY = 0;

export function App({ vault, initialProject, initialImport }: AppProps) {
  const { exit } = useApp();
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  const { write } = useStdout();
  const [clearKey, setClearKey] = useState(0);
  const [project, setProject] = useState<string | null>(initialProject);
  const [history, setHistory] = useState<HistItem[]>(
    welcomeItems().map((l) => ({ ...l, key: LINE_KEY++ }))
  );
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState(0);
  const [, setRedraw] = useState(0);

  // Interactive selectors (entered via /list, /projects, /search, /o, /import).
  const [mode, setMode] = useState<
    "repl" | "browse" | "projects" | "results" | "quickopen" | "import" | "confirm" | "batchInput"
  >("repl");
  const [pendingRm, setPendingRm] = useState<string | null>(null);
  const [pendingRmList, setPendingRmList] = useState<string[] | null>(null);
  // Multi-select + batch actions in the browser (F11).
  const [browseSelected, setBrowseSelected] = useState<Set<string>>(new Set());
  const [batchKind, setBatchKind] = useState<"move" | "status" | "tag" | null>(null);
  const [batchTargets, setBatchTargets] = useState<string[]>([]);
  const [batchValue, setBatchValue] = useState("");
  const [browseDocs, setBrowseDocs] = useState<DocInfo[]>([]);
  const [browseSel, setBrowseSel] = useState(0);
  const [browseTitle, setBrowseTitle] = useState("");
  const [projNames, setProjNames] = useState<string[]>([]);
  const [projSel, setProjSel] = useState(0);
  // Interactive search results (F01).
  const [resultHits, setResultHits] = useState<SearchHit[]>([]);
  const [resultSel, setResultSel] = useState(0);
  const [resultTitle, setResultTitle] = useState("");
  // Fuzzy quick-open palette (F02).
  const [quickDocs, setQuickDocs] = useState<DocInfo[]>([]);
  const [quickQuery, setQuickQuery] = useState("");
  const [quickSel, setQuickSel] = useState(0);
  // Interactive import triage (F09).
  const [importItems, setImportItems] = useState<TriageItem[]>([]);
  const [importSel, setImportSel] = useState(0);
  const [importMove, setImportMove] = useState(false);
  const [importTags, setImportTags] = useState<string[]>([]);
  const [importDir, setImportDir] = useState("");

  const suggestions = suggest(value);
  const menuWidth = Math.min((process.stdout.columns || 80) - 4, 76);
  const sel = suggestions.length > 0 ? Math.min(selected, suggestions.length - 1) : 0;

  function append(lines: OutLine[]) {
    setHistory((h) => [...h, ...lines.map((l) => ({ ...l, key: LINE_KEY++ }))]);
  }

  /** Truly clear: wipe the terminal (incl. scrollback), reset history, and
   *  remount <Static> so its committed lines are forgotten. */
  function clearScreen() {
    const ESC = String.fromCharCode(27);
    try {
      write(`${ESC}[2J${ESC}[3J${ESC}[H`); // clear screen + scrollback + home
    } catch {
      /* ignore (non-TTY) */
    }
    setHistory([]);
    setClearKey((k) => k + 1);
  }

  /** Suspend Ink, show content in the same-terminal pager, resume. */
  function runPager(rendered: string, startLine?: number): boolean {
    if (!process.stdout.isTTY || !isRawModeSupported) return false;
    try {
      setRawMode(false);
      stdin.pause();
      spawnPager(rendered, startLine);
    } finally {
      stdin.resume();
      setRawMode(true);
      setRedraw((r) => r + 1); // force Ink to repaint after the pager
    }
    return true;
  }

  /**
   * Read a doc (scope-checked) and view it in the pager. Normally renders
   * Markdown; when `startLine` is given (a search hit) it pages the *raw*
   * source so the pager's line numbers line up with the match.
   */
  function pageDoc(proj: string, rel: string, startLine?: number): void {
    let content: string;
    try {
      content = core.readDoc(vault, proj, rel);
    } catch (e) {
      const msg = e instanceof DockyError ? e.message : `错误: ${(e as Error).message}`;
      append([{ text: "› " + rel, level: "in" }, { text: msg, level: "err" }]);
      return;
    }
    const view = startLine ? content : renderMarkdown(content);
    if (!runPager(view, startLine)) {
      // no TTY: fall back to inline output
      append([{ text: "› " + rel, level: "in" }, ...view.split("\n").map((t) => ({ text: t, level: "out" as const }))]);
    }
  }

  /** Record the open (F04 recents) then page the doc. Single funnel for every
   *  "open a document" path: /open, browse, search hits, quick-open. */
  function openDoc(proj: string, rel: string, startLine?: number): void {
    try {
      core.recordOpen(vault, proj, rel);
    } catch {
      /* recency is best-effort; never block opening */
    }
    pageDoc(proj, rel, startLine);
  }

  /** /new <type> [name]: scaffold from the type template, record it, and open
   *  the fresh draft in the external editor (F06). */
  function newDoc(args: string[]): void {
    if (!project) {
      append([{ text: "› /new", level: "in" }, { text: "当前没有选中项目,用 /use 切换。", level: "err" }]);
      return;
    }
    if (!args[0]) {
      append([{ text: "› /new", level: "in" }, { text: "用法: /new <类型> [名]", level: "err" }]);
      return;
    }
    const name = args.slice(1).join(" ") || undefined;
    try {
      const dest = core.scaffold(vault, project, args[0], name);
      const rel = dest.split(/[\\/]/).slice(-2).join("/");
      core.recordOpen(vault, project, rel);
      append([{ text: `已创建草稿 ${rel}(status: draft)`, level: "ok" }]);
      openExternally(dest);
    } catch (e) {
      const msg = e instanceof DockyError ? e.message : `错误: ${(e as Error).message}`;
      append([{ text: "› /new " + args.join(" "), level: "in" }, { text: msg, level: "err" }]);
    }
  }

  /** Soft-delete a doc into the trash (F10). */
  function doRm(rel: string): void {
    if (!project) {
      append([{ text: "› /rm " + rel, level: "in" }, { text: "当前没有选中项目,用 /use 切换。", level: "err" }]);
      return;
    }
    try {
      core.removeDoc(vault, project, rel);
      append([{ text: `已移入回收站 ${rel}(可 /undo 或 /restore)`, level: "ok" }]);
    } catch (e) {
      const msg = e instanceof DockyError ? e.message : `错误: ${(e as Error).message}`;
      append([{ text: "› /rm " + rel, level: "in" }, { text: msg, level: "err" }]);
    }
  }

  /** /diff <rel> [revA] [revB]: render a colorized diff in the pager (F08). */
  function showDiff(args: string[]): void {
    if (!project) {
      append([{ text: "› /diff", level: "in" }, { text: "当前没有选中项目,用 /use 切换。", level: "err" }]);
      return;
    }
    if (!args[0]) {
      append([{ text: "› /diff", level: "in" }, { text: "用法: /diff <相对路径> [revA] [revB]", level: "err" }]);
      return;
    }
    try {
      const diff = core.diffDoc(vault, project, args[0], args[1], args[2]);
      if (!diff.trim()) {
        append([{ text: "› /diff " + args.join(" "), level: "in" }, { text: "(无差异)", level: "info" }]);
        return;
      }
      if (!runPager(colorizeDiff(diff))) {
        append([
          { text: "› /diff " + args.join(" "), level: "in" },
          ...diff.split("\n").map((t) => ({ text: t, level: "out" as const })),
        ]);
      }
    } catch (e) {
      const msg = e instanceof DockyError ? e.message : `错误: ${(e as Error).message}`;
      append([{ text: "› /diff " + args.join(" "), level: "in" }, { text: msg, level: "err" }]);
    }
  }

  /** /open <rel> in REPL mode. */
  function openInPager(rel: string): void {
    if (!project) {
      append([{ text: "› /open " + rel, level: "in" }, { text: "当前没有选中项目,用 /use 切换。", level: "err" }]);
      return;
    }
    openDoc(project, rel);
  }

  /** Enter the interactive, hierarchical document browser. `args` accepts the
   *  same filters as /list: `[type] [--status S] [#tag] [--stale]` (F03). */
  function enterBrowse(args: string[] = []): void {
    const echo = "› /list " + args.join(" ");
    if (!project) {
      append([{ text: echo, level: "in" }, { text: "当前没有选中项目,用 /use 切换。", level: "err" }]);
      return;
    }
    const f = parseListArgs(args);
    let docs: DocInfo[];
    try {
      docs = core.filterDocs(core.listDocs(vault, project, f.type), {
        status: f.status,
        tag: f.tag,
        stale: f.stale,
      });
    } catch (e) {
      const msg = e instanceof DockyError ? e.message : `错误: ${(e as Error).message}`;
      append([{ text: echo, level: "in" }, { text: msg, level: "err" }]);
      return;
    }
    if (docs.length === 0) {
      append([{ text: echo, level: "in" }, { text: "(无文档)", level: "info" }]);
      return;
    }
    const sub = [
      f.type,
      f.status && "status:" + f.status,
      f.tag && "#" + f.tag,
      f.stale && "⚠stale",
    ]
      .filter(Boolean)
      .join(" · ");
    setBrowseDocs(docs);
    setBrowseSel(0);
    setBrowseSelected(new Set());
    setBrowseTitle(`${project}${sub ? " · " + sub : ""}  (${docs.length} 篇)`);
    setMode("browse");
  }

  /** Rels targeted by a batch action: the multi-selection, else the cursor. */
  function batchRels(): string[] {
    if (browseSelected.size > 0) return [...browseSelected];
    const d = browseDocs[browseSel];
    return d ? [d.rel] : [];
  }

  /** Run a batch action over the selection (single F08 commit) and report. */
  function runBatch(kind: "move" | "status" | "tag", arg: string): void {
    if (!project) return;
    const rels = batchTargets;
    const a = arg.trim();
    if (rels.length === 0 || !a) {
      setMode("browse");
      return;
    }
    try {
      let res;
      let summary = "";
      if (kind === "move") {
        res = core.batchMove(vault, project, rels, a, { force: false });
        summary = `已移动 ${res.ok.length} 篇 → ${a}`;
      } else if (kind === "status") {
        res = core.batchSetStatus(vault, project, rels, a);
        summary = `已将 ${res.ok.length} 篇设为 ${a.toLowerCase()}`;
      } else {
        res = core.batchAddTags(vault, project, rels, a.split(/[\s,]+/).filter(Boolean));
        summary = `已为 ${res.ok.length} 篇打标 #${a}`;
      }
      const errs = res.errors.length ? `(${res.errors.length} 失败)` : "";
      append([{ text: `${summary}${errs}`, level: res.errors.length ? "err" : "ok" }]);
    } catch (e) {
      const msg = e instanceof DockyError ? e.message : `错误: ${(e as Error).message}`;
      append([{ text: msg, level: "err" }]);
    }
    setBrowseSelected(new Set());
    setMode("repl");
  }

  /** Enter the interactive project selector. */
  function enterProjects(): void {
    const names = Object.keys(core.listProjects(vault));
    if (names.length === 0) {
      append([{ text: "› /projects", level: "in" }, { text: "还没有注册任何项目,用 /register 注册。", level: "info" }]);
      return;
    }
    setProjNames(names);
    setProjSel(Math.max(0, project ? names.indexOf(project) : 0));
    setMode("projects");
  }

  /** Enter the interactive search-results selector (F01). `args` may lead with
   *  `-t <type>` to scope the search to a single document type. */
  function enterResults(args: string[]): void {
    let type: string | undefined;
    let rest = args;
    if (args[0] === "-t" && args[1]) {
      type = args[1];
      rest = args.slice(2);
    }
    const query = rest.join(" ").trim();
    const echo = "› /search " + args.join(" ");
    if (!project) {
      append([{ text: echo, level: "in" }, { text: "当前没有选中项目,用 /use 切换。", level: "err" }]);
      return;
    }
    if (!query) {
      append([{ text: echo, level: "in" }, { text: "用法: /search [-t 类型] <关键词>", level: "err" }]);
      return;
    }
    let hits: SearchHit[];
    try {
      hits = core.searchDocs(vault, project, query, type);
    } catch (e) {
      const msg = e instanceof DockyError ? e.message : `错误: ${(e as Error).message}`;
      append([{ text: echo, level: "in" }, { text: msg, level: "err" }]);
      return;
    }
    if (hits.length === 0) {
      append([{ text: echo, level: "in" }, { text: `无命中: '${query}'`, level: "info" }]);
      return;
    }
    setResultHits(hits);
    setResultSel(0);
    setResultTitle(`search: ${query}${type ? " · " + type : ""}  (${hits.length} 命中)`);
    setMode("results");
  }

  /** Enter the fuzzy quick-open palette (F02). */
  function enterQuickOpen(initial = ""): void {
    if (!project) {
      append([{ text: "› /o", level: "in" }, { text: "当前没有选中项目,用 /use 切换。", level: "err" }]);
      return;
    }
    let docs: DocInfo[];
    try {
      docs = core.listDocs(vault, project);
    } catch (e) {
      const msg = e instanceof DockyError ? e.message : `错误: ${(e as Error).message}`;
      append([{ text: "› /o", level: "in" }, { text: msg, level: "err" }]);
      return;
    }
    if (docs.length === 0) {
      append([{ text: "› /o", level: "in" }, { text: "(无文档)", level: "info" }]);
      return;
    }
    // Empty-query default ordering: pinned first, then most-recent (F04).
    const ranked = [...core.getPins(vault, project), ...core.getRecents(vault, project)];
    const rank = new Map<string, number>();
    ranked.forEach((rel, i) => {
      if (!rank.has(rel)) rank.set(rel, i);
    });
    docs = [...docs].sort((a, b) => (rank.get(a.rel) ?? 1e9) - (rank.get(b.rel) ?? 1e9));
    setQuickDocs(docs);
    setQuickQuery(initial);
    setQuickSel(0);
    setMode("quickopen");
  }

  /** Enter a selectable list of pinned + recently-opened docs (F04). */
  function enterRecent(): void {
    if (!project) {
      append([{ text: "› /recent", level: "in" }, { text: "当前没有选中项目,用 /use 切换。", level: "err" }]);
      return;
    }
    const byRel = new Map(core.listDocs(vault, project).map((d) => [d.rel, d]));
    const ordered: DocInfo[] = [];
    const seen = new Set<string>();
    for (const rel of [...core.getPins(vault, project), ...core.getRecents(vault, project)]) {
      if (seen.has(rel)) continue;
      const d = byRel.get(rel);
      if (d) {
        ordered.push(d);
        seen.add(rel);
      }
    }
    if (ordered.length === 0) {
      append([{ text: "› /recent", level: "in" }, { text: "(暂无最近/置顶)", level: "info" }]);
      return;
    }
    setBrowseDocs(ordered);
    setBrowseSel(0);
    setBrowseTitle(`📌 置顶 + 🕘 最近  (${ordered.length})`);
    setMode("browse");
  }

  /** Enter interactive import triage for a directory (F09). Args may include a
   *  directory and `#tag` tokens applied to imported docs. */
  function enterImport(args: string[]): void {
    if (!project) {
      append([{ text: "› /import", level: "in" }, { text: "当前没有选中项目,用 /use 切换。", level: "err" }]);
      return;
    }
    const tags = args.filter((a) => a.startsWith("#") && a.length > 1).map((a) => a.slice(1));
    const dirArg = args.find((a) => !a.startsWith("#"));
    const dir = path.resolve(dirArg ?? process.cwd());
    let plan;
    try {
      plan = planImport(dir, vault);
    } catch (e) {
      const msg = e instanceof DockyError ? e.message : `错误: ${(e as Error).message}`;
      append([{ text: "› /import " + args.join(" "), level: "in" }, { text: msg, level: "err" }]);
      return;
    }
    if (plan.length === 0) {
      append([{ text: "› /import " + args.join(" "), level: "in" }, { text: `未在 ${dir} 找到可导入的 .md`, level: "info" }]);
      return;
    }
    const order: Record<Confidence, number> = { high: 0, medium: 1, none: 2 };
    const sorted = [...plan].sort((a, b) => order[a.confidence] - order[b.confidence]);
    setImportItems(
      sorted.map((p) => ({
        src: p.src,
        rel: path.relative(dir, p.src) || path.basename(p.src),
        type: p.type,
        confidence: p.confidence,
        reason: p.reason,
        selected: p.type !== null, // classified are pre-selected; unclassified need a decision
      }))
    );
    setImportSel(0);
    setImportMove(false);
    setImportTags(tags);
    setImportDir(dir);
    setMode("import");
  }

  function updateImport(i: number, patch: Partial<TriageItem>): void {
    setImportItems((items) => items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }

  /** Cycle the selected item's type through DOC_TYPES (and select it). */
  function cycleImportType(): void {
    const it = importItems[importSel];
    if (!it) return;
    const cur = it.type ? DOC_TYPES.indexOf(it.type as (typeof DOC_TYPES)[number]) : -1;
    const next = DOC_TYPES[(cur + 1) % DOC_TYPES.length];
    updateImport(importSel, { type: next, selected: true });
  }

  /** Apply the selected, typed triage items via importer (with tags + frontmatter). */
  function applyTriage(): void {
    const toImport = importItems.filter((i) => i.selected && i.type);
    if (toImport.length === 0) {
      append([{ text: "没有选中可导入的项", level: "info" }]);
      setMode("repl");
      return;
    }
    try {
      const results = applyImport(
        vault,
        project!,
        toImport.map((i) => ({ src: i.src, type: i.type, tags: importTags })),
        { move: importMove, frontmatter: true }
      );
      append([
        {
          text: `已${importMove ? "移动" : "复制"} ${results.length} 篇到 ${project}${
            importTags.length ? ` (#${importTags.join(" #")})` : ""
          }`,
          level: "ok",
        },
        ...results.map((r) => ({ text: `  + ${r.type}/${r.dest.split(/[\\/]/).pop()}`, level: "out" as const })),
      ]);
    } catch (e) {
      const msg = e instanceof DockyError ? e.message : `错误: ${(e as Error).message}`;
      append([{ text: msg, level: "err" }]);
    }
    setMode("repl");
  }

  /** Docs currently matching the quick-open query, ranked. */
  function quickMatches(): DocInfo[] {
    return fuzzy(quickQuery, quickDocs, (d) => `${d.type} ${d.title} ${d.name}`);
  }

  /** One-key scope self-heal (F05): create the vault if missing, then register
   *  the current directory under its inferred name and switch into it. */
  function selfHeal(): void {
    const cwd = process.cwd();
    let scope = core.detectScope(vault, cwd);
    try {
      if (scope.kind === "no-vault") {
        core.initVault(vault);
        append([{ text: "已初始化中心库(vault)", level: "ok" }]);
        scope = core.detectScope(vault, cwd);
      }
      if (scope.kind === "unregistered-repo" || scope.kind === "no-repo") {
        const localPath = scope.kind === "unregistered-repo" ? scope.root : cwd;
        core.registerProject(vault, scope.suggestedName, localPath);
        setProject(scope.suggestedName);
        append([{ text: `已注册并切换到 ${scope.suggestedName}`, level: "ok" }]);
      }
    } catch (e) {
      const msg = e instanceof DockyError ? e.message : `错误: ${(e as Error).message}`;
      append([{ text: msg, level: "err" }]);
    }
    setValue("");
  }

  function runRaw(raw: string) {
    const body = raw.trim().replace(/^\//, "");
    const [c, ...a] = body.split(/\s+/);
    if (c.toLowerCase() === "open" && a[0]) {
      openInPager(a[0]);
      setValue("");
      return;
    }
    if (c.toLowerCase() === "list") {
      enterBrowse(a);
      setValue("");
      return;
    }
    if (c.toLowerCase() === "projects") {
      enterProjects();
      setValue("");
      return;
    }
    if (c.toLowerCase() === "search" && a.length) {
      enterResults(a);
      setValue("");
      return;
    }
    if (c.toLowerCase() === "o") {
      enterQuickOpen(a.join(" "));
      setValue("");
      return;
    }
    if (c.toLowerCase() === "recent") {
      enterRecent();
      setValue("");
      return;
    }
    if (c.toLowerCase() === "new") {
      newDoc(a);
      setValue("");
      return;
    }
    if (c.toLowerCase() === "diff") {
      showDiff(a);
      setValue("");
      return;
    }
    if (c.toLowerCase() === "import") {
      enterImport(a);
      setValue("");
      return;
    }
    if (c.toLowerCase() === "rm") {
      const rel = a.find((x) => !x.startsWith("--"));
      const yes = a.includes("--yes") || a.includes("-y");
      if (!rel) {
        append([{ text: "› /rm", level: "in" }, { text: "用法: /rm <相对路径> [--yes]", level: "err" }]);
      } else if (yes) {
        doRm(rel);
      } else {
        setPendingRm(rel);
        setMode("confirm");
      }
      setValue("");
      return;
    }
    const res = executeCommand(vault, project, raw);
    if (res.clear) {
      clearScreen();
      setValue("");
      return;
    }
    append(res.output);
    if (res.project !== undefined) setProject(res.project);
    setValue("");
    if (res.exit) exit();
  }

  function onSubmit(raw: string) {
    if (!raw.trim()) return;
    // If the command menu is open, Enter acts on the highlighted command.
    if (suggestions.length > 0) {
      const chosen = suggestions[sel];
      if (chosen.args) {
        // Needs arguments: complete into the input and wait for them.
        setValue(`/${chosen.name} `);
        setSelected(0);
        return;
      }
      runRaw(`/${chosen.name}`);
      return;
    }
    runRaw(raw);
  }

  useInput((input, key) => {
    // Global: Ctrl-P opens the fuzzy quick-open palette from the REPL.
    if (mode === "repl" && key.ctrl && input === "p") {
      enterQuickOpen();
      return;
    }
    // F05: with no project and an empty prompt, R fires the scope self-heal
    // (register this dir / create vault). Gated on empty input so it never
    // hijacks a normal keystroke once you start typing.
    if (mode === "repl" && !project && value === "" && (input === "r" || input === "R")) {
      selfHeal();
      return;
    }
    // Interactive search results navigation (F01).
    if (mode === "results") {
      if (key.upArrow) setResultSel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setResultSel((s) => Math.min(resultHits.length - 1, s + 1));
      else if (key.return) {
        const h = resultHits[resultSel];
        if (h && project) openDoc(project, h.rel, h.line || undefined);
      } else if (input === "e") {
        const h = resultHits[resultSel];
        if (h && project) {
          try {
            openExternally(core.safePath(vault, project, h.rel), h.line || undefined);
            append([{ text: `已用编辑器打开 ${h.rel}${h.line ? ":" + h.line : ""}`, level: "ok" }]);
          } catch (e) {
            append([{ text: `错误: ${(e as Error).message}`, level: "err" }]);
          }
        }
      } else if (key.escape || input === "q") {
        setMode("repl");
      }
      return;
    }
    // Delete confirmation, single (F10) or batch (F11).
    if (mode === "confirm") {
      if (input === "y" || input === "Y") {
        if (pendingRmList) {
          const rels = pendingRmList;
          setPendingRmList(null);
          setBrowseSelected(new Set());
          setMode("repl");
          if (project && rels.length) {
            try {
              const res = core.batchRemove(vault, project, rels);
              append([{ text: `已移入回收站 ${res.ok.length} 篇(可 /undo)`, level: "ok" }]);
            } catch (e) {
              append([{ text: `错误: ${(e as Error).message}`, level: "err" }]);
            }
          }
        } else {
          const rel = pendingRm;
          setPendingRm(null);
          setMode("repl");
          if (rel) doRm(rel);
        }
      } else {
        setPendingRm(null);
        setPendingRmList(null);
        setMode("repl");
        append([{ text: "已取消删除", level: "info" }]);
      }
      return;
    }
    // Batch action argument input (F11): typing + Enter handled by the TextInput.
    if (mode === "batchInput") {
      if (key.escape) setMode("browse");
      return;
    }
    // Import triage navigation (F09).
    if (mode === "import") {
      if (key.upArrow) setImportSel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setImportSel((s) => Math.min(importItems.length - 1, s + 1));
      else if (input === " " || key.return) updateImport(importSel, { selected: !importItems[importSel]?.selected });
      else if (input === "t") cycleImportType();
      else if (input === "s") updateImport(importSel, { selected: false });
      else if (input === "m") setImportMove((v) => !v);
      else if (input === "p") {
        const it = importItems[importSel];
        if (it) {
          try {
            runPager(renderMarkdown(fs.readFileSync(it.src, "utf-8")));
          } catch {
            append([{ text: `无法读取 ${it.rel}`, level: "err" }]);
          }
        }
      } else if (input === "a") applyTriage();
      else if (key.escape || input === "q") setMode("repl");
      return;
    }
    // Fuzzy quick-open palette navigation (F02). Typing + Enter are handled by
    // the palette's TextInput; here we only move the selection / cancel.
    if (mode === "quickopen") {
      if (key.upArrow) setQuickSel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setQuickSel((s) => Math.min(Math.max(0, quickMatches().length - 1), s + 1));
      else if (key.escape) setMode("repl");
      return;
    }
    // Document browser navigation + multi-select batch actions (F11).
    if (mode === "browse") {
      if (key.upArrow) setBrowseSel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setBrowseSel((s) => Math.min(browseDocs.length - 1, s + 1));
      else if (input === " ") {
        const d = browseDocs[browseSel];
        if (d)
          setBrowseSelected((sel) => {
            const n = new Set(sel);
            n.has(d.rel) ? n.delete(d.rel) : n.add(d.rel);
            return n;
          });
      } else if (input === "a") {
        setBrowseSelected(new Set(browseDocs.map((d) => d.rel)));
      } else if (input === "A") {
        setBrowseSelected((sel) => new Set(browseDocs.filter((d) => !sel.has(d.rel)).map((d) => d.rel)));
      } else if (input === "d") {
        const rels = batchRels();
        if (rels.length) {
          setPendingRmList(rels);
          setMode("confirm");
        }
      } else if (input === "m" || input === "s" || input === "#") {
        const rels = batchRels();
        if (rels.length) {
          setBatchTargets(rels);
          setBatchKind(input === "m" ? "move" : input === "s" ? "status" : "tag");
          setBatchValue("");
          setMode("batchInput");
        }
      } else if (key.return) {
        // Enter = full read in the same-terminal pager (no app switch).
        const d = browseDocs[browseSel];
        if (d) openDoc(d.project, d.rel);
      } else if (input === "e") {
        // e = open in the external editor (only when you actually want to edit).
        const d = browseDocs[browseSel];
        if (d) {
          openExternally(d.path);
          append([{ text: `已用默认应用打开 ${d.rel}`, level: "ok" }]);
        }
      } else if (input === "h") {
        // h = show this doc's commit history timeline (F08).
        const d = browseDocs[browseSel];
        if (d) {
          const commits = core.logDoc(vault, d.project, d.rel);
          if (commits.length === 0) {
            append([{ text: `${d.rel} 无提交历史`, level: "info" }]);
          } else {
            append([
              { text: `📜 ${d.rel}`, level: "info" },
              ...commits.map((c) => ({ text: `  ${c.hash}  ${c.date}  ${c.subject}`, level: "out" as const })),
            ]);
          }
        }
      } else if (key.escape || input === "q") {
        setMode("repl");
      }
      return;
    }
    // Project selector navigation.
    if (mode === "projects") {
      if (key.upArrow) setProjSel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setProjSel((s) => Math.min(projNames.length - 1, s + 1));
      else if (key.return) {
        const name = projNames[projSel];
        if (name) {
          setProject(name);
          append([{ text: `已切换到项目 ${name}`, level: "ok" }]);
        }
        setMode("repl");
      } else if (key.escape || input === "q") {
        setMode("repl");
      }
      return;
    }
    // Command menu navigation.
    if (suggestions.length === 0) return;
    if (key.downArrow) setSelected((s) => Math.min(s + 1, suggestions.length - 1));
    else if (key.upArrow) setSelected((s) => Math.max(s - 1, 0));
    else if (key.tab) {
      // Tab completes the highlighted command (then awaits args, if any).
      setValue(`/${suggestions[sel].name} `);
      setSelected(0);
    }
  });

  // SelectableList items for browse mode (type headers + status/tags meta, F11).
  function browseItems(): SelectableItem[] {
    return browseDocs.map((d) => {
      const meta = [
        d.status !== "active" ? `[${d.status}]` : "",
        d.tags.length ? d.tags.map((t) => `#${t}`).join(" ") : "",
      ]
        .filter(Boolean)
        .join(" ");
      return { id: d.rel, group: `${d.type}/`, marker: d.stale ? "⚠ " : "", label: d.name, meta: meta || undefined };
    });
  }

  // Items for interactive search results: grouped by type, `name:line` + snippet.
  function resultItems(): SelectableItem[] {
    return resultHits.map((h, i) => {
      const slash = h.rel.indexOf("/");
      const type = slash >= 0 ? h.rel.slice(0, slash) : h.rel;
      const name = slash >= 0 ? h.rel.slice(slash + 1) : h.rel;
      return { id: `${h.rel}:${h.line}:${i}`, group: `${type}/`, label: h.line ? `${name}:${h.line}` : name, meta: h.snippet };
    });
  }

  // Items for the fuzzy quick-open palette: type/ + title + dim file name.
  function quickItems(matches: DocInfo[]): SelectableItem[] {
    return matches.map((d) => ({ id: d.rel, label: `${d.type}/ ${d.title}`, meta: `(${d.name})` }));
  }

  // Rows for import triage: grouped by confidence, with checkboxes + type + reason.
  function importRows(): React.ReactNode[] {
    const labels: Record<Confidence, string> = { high: "HIGH", medium: "MEDIUM", none: "未分类(需人工)" };
    const rows: React.ReactNode[] = [];
    let lastConf: Confidence | "" = "";
    importItems.forEach((it, i) => {
      if (it.confidence !== lastConf) {
        rows.push(
          <Text key={"ch-" + it.confidence} color={it.confidence === "none" ? "red" : "yellow"} bold>
            {labels[it.confidence]}
          </Text>
        );
        lastConf = it.confidence;
      }
      const active = i === importSel;
      const box = it.selected ? "[x]" : "[ ]";
      const type = it.type ?? "?";
      rows.push(
        <Box key={it.src}>
          <Text color={active ? "cyanBright" : undefined} inverse={active}>
            {active ? "▸ " : "  "}
            {box} {type.padEnd(12)} {it.rel}
          </Text>
          <Text dimColor>{"  " + it.reason}</Text>
        </Box>
      );
    });
    return rows;
  }

  // Items for the project selector (name + dim path).
  function projectItems(): SelectableItem[] {
    const meta = core.listProjects(vault);
    return projNames.map((name) => ({ id: name, label: name, meta: (meta[name]?.paths ?? []).join(", ") || undefined }));
  }

  // F09: if launched with `docky import -i`, jump straight into triage.
  useEffect(() => {
    if (initialImport) enterImport([initialImport.dir, ...(initialImport.tags ?? []).map((t) => "#" + t)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const quickList = mode === "quickopen" ? quickMatches() : [];

  // Homepage springboard: on a fresh REPL screen, surface pins + recents (F04).
  const atHome = mode === "repl" && value === "" && suggestions.length === 0 && history.length <= 1;
  const homePins = atHome && project ? core.getPins(vault, project) : [];
  const homeRecents = atHome && project ? core.getRecents(vault, project) : [];
  const showHome = homePins.length > 0 || homeRecents.length > 0;
  // Onboarding / self-heal card when there's no active project (F05).
  const scope = atHome && !project ? core.detectScope(vault, process.cwd()) : null;

  return (
    <Box flexDirection="column">
      <Static key={clearKey} items={history}>
        {(l) =>
          l.banner ? (
            <Banner key={l.key} />
          ) : (
            <Text key={l.key} color={colorOf(l.level)}>
              {l.text || " "}
            </Text>
          )
        }
      </Static>

      {mode === "browse" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">
            {browseTitle}
            {browseSelected.size > 0 ? `  · 已选 ${browseSelected.size}` : ""}
          </Text>
          <SelectableList items={browseItems()} activeIndex={browseSel} selected={browseSelected} />
          <Box marginTop={1}>
            <Text dimColor>Space 选 · a 全选 · A 反选 · m 移动 · d 删除 · # 打标 · s 状态 · Enter 预览 · h 历史 · Esc 返回</Text>
          </Box>
        </Box>
      ) : mode === "projects" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">已注册项目 ({projNames.length})</Text>
          <SelectableList items={projectItems()} activeIndex={projSel} />
          <Box marginTop={1}>
            <Text dimColor>↑/↓ 选择 · Enter 切换到该项目 · Esc/q 返回</Text>
          </Box>
        </Box>
      ) : mode === "results" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">{resultTitle}</Text>
          <SelectableList items={resultItems()} activeIndex={resultSel} />
          <Box marginTop={1}>
            <Text dimColor>↑/↓ 选择 · Enter 跳到匹配行 · e 编辑器打开 · Esc/q 返回</Text>
          </Box>
        </Box>
      ) : mode === "confirm" ? (
        <Box marginTop={1}>
          <Text color="yellow">
            {pendingRmList
              ? `⚠ 确认删除 ${pendingRmList.length} 篇?(移入 .trash,可 restore)  [y/N]`
              : `⚠ 确认删除 ${pendingRm}?(移入 .trash,可 restore)  [y/N]`}
          </Text>
        </Box>
      ) : mode === "batchInput" ? (
        <Box marginTop={1}>
          <Text color="cyan">
            {(batchKind === "move" ? "批量移动到类型" : batchKind === "status" ? "批量改状态" : "批量打标")} (
            {batchTargets.length} 篇) ›{" "}
          </Text>
          <TextInput
            value={batchValue}
            onChange={setBatchValue}
            onSubmit={(v) => runBatch(batchKind ?? "tag", v)}
            placeholder={
              batchKind === "move" ? "design/plan/debug/code-review/prompts" : batchKind === "status" ? "draft/active/done/archived" : "空格分隔的标签"
            }
          />
        </Box>
      ) : mode === "import" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">
            导入三筛 · {importDir}  ({importItems.length} 候选 · {importMove ? "move" : "copy"}
            {importTags.length ? ` · #${importTags.join(" #")}` : ""})
          </Text>
          {importRows()}
          <Box marginTop={1}>
            <Text dimColor>↑/↓ · Space 勾选 · t 改类 · s 跳过 · p 预览 · m copy/move · a 应用 · Esc 退出</Text>
          </Box>
        </Box>
      ) : mode === "quickopen" ? (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color="cyan">quick open › </Text>
            <TextInput
              value={quickQuery}
              onChange={(v) => {
                setQuickQuery(v.replace(/\t/g, ""));
                setQuickSel(0);
              }}
              onSubmit={() => {
                const d = quickList[Math.min(quickSel, quickList.length - 1)];
                if (d && project) {
                  setMode("repl");
                  openDoc(project, d.rel);
                }
              }}
              placeholder="输入关键词模糊匹配文档名/标题/类型"
            />
          </Box>
          <SelectableList items={quickItems(quickList)} activeIndex={quickSel} emptyText="  无匹配" />
          <Box marginTop={1}>
            <Text dimColor>↑/↓ 选择 · Enter 打开 · Esc 取消</Text>
          </Box>
        </Box>
      ) : (
        <>
          {scope && scope.kind !== "registered" && (
            <Box flexDirection="column" marginTop={1}>
              {scope.kind === "no-vault" ? (
                <>
                  <Text color="yellow">docky 中心库(vault)尚未初始化。</Text>
                  <Text>
                    {"  ▸ 按 "}
                    <Text color="cyanBright" bold>
                      R
                    </Text>
                    {" 一键创建 vault 并注册当前目录"}
                  </Text>
                </>
              ) : scope.kind === "unregistered-repo" ? (
                <>
                  <Text color="yellow">此目录是 git 仓库但尚未注册到 docky。</Text>
                  <Text>
                    {"  ▸ 按 "}
                    <Text color="cyanBright" bold>
                      R
                    </Text>
                    {` 注册为 ${scope.suggestedName}  `}
                    <Text dimColor>{scope.root}</Text>
                  </Text>
                  <Text dimColor>{`  或手动:docky register ${scope.suggestedName}`}</Text>
                </>
              ) : (
                <>
                  <Text color="yellow">此目录尚未注册到 docky。</Text>
                  <Text>
                    {"  ▸ 按 "}
                    <Text color="cyanBright" bold>
                      R
                    </Text>
                    {` 注册为 ${scope.suggestedName}`}
                  </Text>
                  <Text dimColor>{`  或手动:docky register ${scope.suggestedName}`}</Text>
                </>
              )}
            </Box>
          )}
          {showHome && (
            <Box flexDirection="column" marginTop={1}>
              {homePins.length > 0 && <Text color="yellow">📌 置顶</Text>}
              {homePins.map((r) => (
                <Text key={"pin-" + r} dimColor>
                  {"  " + r}
                </Text>
              ))}
              {homeRecents.length > 0 && <Text color="cyan">🕘 最近</Text>}
              {homeRecents.map((r) => (
                <Text key={"rec-" + r} dimColor>
                  {"  " + r}
                </Text>
              ))}
              <Text dimColor>{"/recent 选择打开 · /pin <路径> 置顶"}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text color="green">{project ? `[${project}] ` : "[no project] "}</Text>
            <Text color="cyan">› </Text>
            <TextInput
              value={value}
              onChange={(v) => {
                setValue(v.replace(/\t/g, ""));
                setSelected(0);
              }}
              onSubmit={onSubmit}
              placeholder="输入命令,/ 看菜单"
            />
          </Box>

          {suggestions.length > 0 && (
            <Box flexDirection="column" marginLeft={2}>
              {suggestions.map((s, i) => (
                <Box key={s.name} width={menuWidth} justifyContent="space-between">
                  <Text color={i === sel ? "cyanBright" : "gray"}>
                    {i === sel ? "▸ " : "  "}
                    {s.usage}
                  </Text>
                  <Text color={i === sel ? "cyan" : "gray"} dimColor={i !== sel}>
                    {s.desc}
                  </Text>
                </Box>
              ))}
            </Box>
          )}

          <Box marginTop={suggestions.length > 0 ? 0 : 1}>
            <Text dimColor>↑/↓ 选择 · Tab 补全 · Enter 执行 · /exit 退出</Text>
          </Box>
        </>
      )}
    </Box>
  );
}

export function runTui(
  vault: string,
  initialProject: string | null,
  initialImport?: { dir: string; tags?: string[] }
): void {
  render(<App vault={vault} initialProject={initialProject} initialImport={initialImport} />);
}

/** Resolve the project to start on (from cwd), tolerating "not registered". */
export function detectProject(vault: string): string | null {
  const s = core.detectScope(vault, process.cwd());
  return s.kind === "registered" ? s.project : null;
}
