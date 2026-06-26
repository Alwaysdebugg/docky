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
import { OutLine, executeCommand, parseListArgs, suggest, suggestArgs } from "./commands.js";
import * as core from "./core.js";
import { DocInfo, DOC_TYPES, DockyError, SearchHit } from "./types.js";
import { colorizeDiff, openExternally, renderMarkdown, spawnPager } from "./pager.js";
import { fuzzy } from "./match.js";
import { Confidence, applyImport, planImport } from "./importer.js";
import { SelectableItem, SelectableList } from "./components/SelectableList.js";
import { Heading, extractHeadings } from "./outline.js";
import { Issue, lintProject } from "./lint.js";
import { GraphLine, buildGraph, graphLines } from "./graph.js";
import { evalFolder, getFolder, listFolders } from "./savedsearch.js";

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
  // F56: a TUI session is tied to one cwd, so the branch is fixed. scoped()
  // maps the current project to its branch bucket for filesystem ops; it is the
  // bare name when branchScope is off, so it's safe to use wherever a project
  // path is needed. Config / cross-project calls keep the bare `project`.
  const [branch] = useState<string | null>(() => core.gitBranch(process.cwd()));
  const scoped = (p: string): string => core.scopedProject(vault, p, branch);
  const [history, setHistory] = useState<HistItem[]>(
    welcomeItems().map((l) => ({ ...l, key: LINE_KEY++ }))
  );
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState(0);
  const [argSel, setArgSel] = useState(0);
  const [, setRedraw] = useState(0);
  // REPL command history + arg completion (F14).
  const [cmdHist, setCmdHist] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1); // -1 = editing current input
  const [reverseNeedle, setReverseNeedle] = useState<string | null>(null);

  // Interactive selectors (entered via /list, /projects, /search, /o, /import).
  const [mode, setMode] = useState<
    | "repl"
    | "browse"
    | "projects"
    | "results"
    | "quickopen"
    | "import"
    | "confirm"
    | "batchInput"
    | "outline"
    | "doctor"
    | "inbox"
    | "graph"
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
  // Agent-output review inbox (F22).
  const [inboxDocs, setInboxDocs] = useState<DocInfo[]>([]);
  const [inboxSel, setInboxSel] = useState(0);
  const [inboxSelected, setInboxSelected] = useState<Set<string>>(new Set());
  // Relationship graph view (F23).
  const [graphItems, setGraphItems] = useState<GraphLine[]>([]);
  const [graphSel, setGraphSel] = useState(0);
  // Doc-doctor issues (F19).
  const [doctorIssues, setDoctorIssues] = useState<Issue[]>([]);
  const [doctorSel, setDoctorSel] = useState(0);
  // Reading-view outline / TOC (F16).
  const [outlineHeadings, setOutlineHeadings] = useState<Heading[]>([]);
  const [outlineSel, setOutlineSel] = useState(0);
  const [outlineRel, setOutlineRel] = useState("");
  const [outlineProj, setOutlineProj] = useState("");
  // Interactive import triage (F09).
  const [importItems, setImportItems] = useState<TriageItem[]>([]);
  const [importSel, setImportSel] = useState(0);
  const [importMove, setImportMove] = useState(false);
  const [importTags, setImportTags] = useState<string[]>([]);
  const [importDir, setImportDir] = useState("");

  const suggestions = suggest(value);
  const argList =
    suggestions.length === 0 && value.startsWith("/")
      ? suggestArgs(vault, project ? scoped(project) : null, value)
      : [];
  const menuWidth = Math.min((process.stdout.columns || 80) - 4, 76);
  const sel = suggestions.length > 0 ? Math.min(selected, suggestions.length - 1) : 0;
  const aSel = argList.length > 0 ? Math.min(argSel, argList.length - 1) : 0;
  // Fixed-height scrolling viewport for the menus (F: keeps a long command list
  // from overflowing). The window follows the cursor, keeping it ~centered.
  const MENU_ROWS = Math.max(6, Math.min(16, (process.stdout.rows || 24) - 9));
  const windowStart = (active: number, total: number): number =>
    Math.min(Math.max(0, total - MENU_ROWS), Math.max(0, active - Math.floor((MENU_ROWS - 1) / 2)));
  const cmdStart = windowStart(sel, suggestions.length);
  const argStart = windowStart(aSel, argList.length);

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
    if (startLine) {
      if (!runPager(content, startLine)) {
        append([{ text: "› " + rel, level: "in" }, ...content.split("\n").map((t) => ({ text: t, level: "out" as const }))]);
      }
      return;
    }
    // Normal read: append an outlinks / backlinks footer (F12).
    let footer = "";
    try {
      const links = core.getLinks(vault, proj, rel);
      const parts: string[] = [];
      const outs = links.outlinks.filter((o) => o.rel).map((o) => o.rel);
      if (outs.length) parts.push(`**出链 →** ${outs.join(" · ")}`);
      if (links.backlinks.length) parts.push(`**被引用 ←** ${links.backlinks.join(" · ")}`);
      if (links.broken.length) parts.push(`**⚠ 失效 →** ${links.broken.map((b) => `[[${b}]]`).join(" · ")}`);
      if (parts.length) footer = "\n\n---\n\n" + parts.join("\n\n") + "\n";
    } catch {
      /* links are best-effort */
    }
    const view = renderMarkdown(content + footer, core.renderPrefs(vault));
    if (!runPager(view)) {
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
      const dest = core.scaffold(vault, scoped(project), args[0], name);
      const rel = dest.split(/[\\/]/).slice(-2).join("/");
      core.recordOpen(vault, scoped(project), rel);
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
      core.removeDoc(vault, scoped(project), rel);
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
      const diff = core.diffDoc(vault, scoped(project), args[0], args[1], args[2]);
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
    openDoc(scoped(project), rel);
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
      docs = core.filterDocs(core.listDocs(vault, scoped(project), f.type), {
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

  /** Show the project relationship graph; Enter opens the selected node (F23). */
  function enterGraph(): void {
    if (!project) {
      append([{ text: "› /graph", level: "in" }, { text: "当前没有选中项目,用 /use 切换。", level: "err" }]);
      return;
    }
    const lines = graphLines(buildGraph(vault, scoped(project)));
    setGraphItems(lines);
    setGraphSel(lines.findIndex((l) => l.rel) >= 0 ? lines.findIndex((l) => l.rel) : 0);
    setMode("graph");
  }

  /** Open the agent-output review inbox (F22). */
  function enterInbox(): void {
    if (!project) {
      append([{ text: "› /inbox", level: "in" }, { text: "当前没有选中项目,用 /use 切换。", level: "err" }]);
      return;
    }
    const pending = core.listPending(vault, scoped(project));
    if (pending.length === 0) {
      append([{ text: "› /inbox", level: "in" }, { text: "收件箱为空(无待审文档)", level: "info" }]);
      return;
    }
    setInboxDocs(pending);
    setInboxSel(0);
    setInboxSelected(new Set());
    setMode("inbox");
  }

  function inboxTargets(): string[] {
    if (inboxSelected.size > 0) return [...inboxSelected];
    const d = inboxDocs[inboxSel];
    return d ? [d.rel] : [];
  }

  /** Re-read pending docs after an inbox action; exit to REPL when emptied. */
  function refreshInbox(summary: OutLine): void {
    append([summary]);
    if (!project) {
      setMode("repl");
      return;
    }
    const pending = core.listPending(vault, scoped(project));
    setInboxSelected(new Set());
    if (pending.length === 0) {
      setMode("repl");
      return;
    }
    setInboxDocs(pending);
    setInboxSel((s) => Math.min(s, pending.length - 1));
  }

  function approveInbox(): void {
    if (!project) return;
    const rels = inboxTargets();
    let n = 0;
    for (const rel of rels) {
      try {
        core.setReview(vault, scoped(project), rel, "approved");
        n++;
      } catch {
        /* skip */
      }
    }
    refreshInbox({ text: `已通过 ${n} 篇`, level: "ok" });
  }

  function returnInbox(): void {
    if (!project) return;
    const rels = inboxTargets();
    let n = 0;
    for (const rel of rels) {
      try {
        core.removeDoc(vault, scoped(project), rel);
        n++;
      } catch {
        /* skip */
      }
    }
    refreshInbox({ text: `已退回 ${n} 篇(移入 .trash,可 /undo)`, level: "ok" });
  }

  /** Run the doc-doctor and show issues; Enter jumps to the doc (F19). */
  function enterDoctor(): void {
    if (!project) {
      append([{ text: "› /doctor", level: "in" }, { text: "当前没有选中项目,用 /use 切换。", level: "err" }]);
      return;
    }
    const issues = lintProject(vault, scoped(project));
    if (issues.length === 0) {
      append([{ text: "› /doctor", level: "in" }, { text: "✓ 文档库健康,无问题", level: "ok" }]);
      return;
    }
    setDoctorIssues(issues);
    setDoctorSel(0);
    setMode("doctor");
  }

  /** Pop the outline (TOC) for a doc; Enter jumps to a heading's line (F16). */
  function enterOutline(proj: string, rel: string): void {
    let content: string;
    try {
      content = core.readDoc(vault, proj, rel);
    } catch (e) {
      const msg = e instanceof DockyError ? e.message : `错误: ${(e as Error).message}`;
      append([{ text: "› /outline " + rel, level: "in" }, { text: msg, level: "err" }]);
      return;
    }
    const headings = extractHeadings(content);
    if (headings.length === 0) {
      append([{ text: "› /outline " + rel, level: "in" }, { text: "(无标题大纲)", level: "info" }]);
      return;
    }
    setOutlineHeadings(headings);
    setOutlineSel(0);
    setOutlineRel(rel);
    setOutlineProj(proj);
    setMode("outline");
  }

  /** Enter a selectable list of a doc's outlinks + backlinks for jumping (F12). */
  function enterLinks(rel: string): void {
    if (!project) {
      append([{ text: "› /links", level: "in" }, { text: "当前没有选中项目,用 /use 切换。", level: "err" }]);
      return;
    }
    let links;
    try {
      links = core.getLinks(vault, scoped(project), rel);
    } catch (e) {
      const msg = e instanceof DockyError ? e.message : `错误: ${(e as Error).message}`;
      append([{ text: "› /links " + rel, level: "in" }, { text: msg, level: "err" }]);
      return;
    }
    const byRel = new Map(core.listDocs(vault, scoped(project)).map((d) => [d.rel, d]));
    const outRels = links.outlinks.filter((o) => o.rel).map((o) => o.rel as string);
    const ordered: DocInfo[] = [];
    const seen = new Set<string>();
    for (const r of [...outRels, ...links.backlinks]) {
      if (seen.has(r)) continue;
      const d = byRel.get(r);
      if (d) {
        ordered.push(d);
        seen.add(r);
      }
    }
    if (ordered.length === 0) {
      const note = links.broken.length ? `(无可跳转链接;⚠ 失效 ${links.broken.length})` : "(无链接)";
      append([{ text: "› /links " + rel, level: "in" }, { text: note, level: "info" }]);
      return;
    }
    setBrowseDocs(ordered);
    setBrowseSel(0);
    setBrowseSelected(new Set());
    setBrowseTitle(
      `🔗 ${rel} · 出链 ${outRels.length} / 入链 ${links.backlinks.length}${
        links.broken.length ? ` · ⚠${links.broken.length}` : ""
      }`
    );
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
        res = core.batchMove(vault, scoped(project), rels, a, { force: false });
        summary = `已移动 ${res.ok.length} 篇 → ${a}`;
      } else if (kind === "status") {
        res = core.batchSetStatus(vault, scoped(project), rels, a);
        summary = `已将 ${res.ok.length} 篇设为 ${a.toLowerCase()}`;
      } else {
        res = core.batchAddTags(vault, scoped(project), rels, a.split(/[\s,]+/).filter(Boolean));
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
    const fuzzy = args.includes("--fuzzy");
    const across = args.includes("--across");
    let rest = args.filter((a) => a !== "--fuzzy" && a !== "--across");
    let type: string | undefined;
    if (rest[0] === "-t" && rest[1]) {
      type = rest[1];
      rest = rest.slice(2);
    }
    const query = rest.join(" ").trim();
    const echo = "› /search " + args.join(" ");
    if (!project) {
      append([{ text: echo, level: "in" }, { text: "当前没有选中项目,用 /use 切换。", level: "err" }]);
      return;
    }
    if (!query) {
      append([{ text: echo, level: "in" }, { text: "用法: /search [-t 类型] [--fuzzy] [--across] <关键词>", level: "err" }]);
      return;
    }
    let hits: SearchHit[];
    try {
      hits = across
        ? core.searchAcross(vault, project, query, { type, fuzzy, branch })
        : core.searchDocs(vault, scoped(project), query, type, {}, { fuzzy });
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
    setResultTitle(
      `search: ${query}${type ? " · " + type : ""}${fuzzy ? " · fuzzy" : ""}${across ? " · across↗" : ""}  (按相关性 · ${hits.length} 命中)`
    );
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
      docs = core.listDocs(vault, scoped(project));
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
    const ranked = [...core.getPins(vault, scoped(project)), ...core.getRecents(vault, scoped(project))];
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

  /** Open a saved smart folder, evaluated live, as a selectable list (F24). */
  function enterFolder(name: string): void {
    if (!project) {
      append([{ text: "› /f", level: "in" }, { text: "当前没有选中项目,用 /use 切换。", level: "err" }]);
      return;
    }
    const query = getFolder(vault, scoped(project), name);
    if (query === null) {
      append([{ text: "› /f " + name, level: "in" }, { text: `没有名为「${name}」的智能文件夹`, level: "err" }]);
      return;
    }
    const docs = evalFolder(vault, scoped(project), query);
    if (docs.length === 0) {
      append([{ text: "› /f " + name, level: "in" }, { text: `📂 ${name}(${query})— 无匹配`, level: "info" }]);
      return;
    }
    setBrowseDocs(docs);
    setBrowseSel(0);
    setBrowseSelected(new Set());
    setBrowseTitle(`📂 ${name} · ${query}  (${docs.length} 篇)`);
    setMode("browse");
  }

  /** Enter a selectable list of pinned + recently-opened docs (F04). */
  function enterRecent(): void {
    if (!project) {
      append([{ text: "› /recent", level: "in" }, { text: "当前没有选中项目,用 /use 切换。", level: "err" }]);
      return;
    }
    const byRel = new Map(core.listDocs(vault, scoped(project)).map((d) => [d.rel, d]));
    const ordered: DocInfo[] = [];
    const seen = new Set<string>();
    for (const rel of [...core.getPins(vault, scoped(project)), ...core.getRecents(vault, scoped(project))]) {
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
        scoped(project!),
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

  /** Record a submitted command into history (F14): in-memory + persisted. */
  function pushHist(raw: string): void {
    const c = raw.trim();
    if (!c) return;
    setCmdHist((h) => (h[h.length - 1] === c ? h : [...h, c]));
    if (project) {
      try {
        core.pushHistory(vault, scoped(project), c);
      } catch {
        /* best-effort */
      }
    }
    setHistIdx(-1);
    setReverseNeedle(null);
  }

  function runRaw(raw: string) {
    pushHist(raw);
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
    if (c.toLowerCase() === "f" && a[0]) {
      enterFolder(a[0]);
      setValue("");
      return;
    }
    if (c.toLowerCase() === "links" && a[0]) {
      enterLinks(a[0]);
      setValue("");
      return;
    }
    if (c.toLowerCase() === "outline" && a[0]) {
      if (project) enterOutline(scoped(project), a[0]);
      else append([{ text: "› /outline", level: "in" }, { text: "当前没有选中项目,用 /use 切换。", level: "err" }]);
      setValue("");
      return;
    }
    if (c.toLowerCase() === "doctor") {
      enterDoctor();
      setValue("");
      return;
    }
    if (c.toLowerCase() === "inbox") {
      enterInbox();
      setValue("");
      return;
    }
    if (c.toLowerCase() === "graph") {
      enterGraph();
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
        if (h && project) openDoc(scoped(h.project ?? project), h.rel, h.line || undefined);
      } else if (input === "e") {
        const h = resultHits[resultSel];
        if (h && project) {
          try {
            openExternally(core.safePath(vault, scoped(h.project ?? project), h.rel), h.line || undefined);
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
    // Relationship graph (F23): navigate nodes, Enter opens the doc.
    if (mode === "graph") {
      if (key.upArrow) setGraphSel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setGraphSel((s) => Math.min(graphItems.length - 1, s + 1));
      else if (key.return) {
        const it = graphItems[graphSel];
        if (it && it.rel && project) {
          setMode("repl");
          openDoc(scoped(project), it.rel);
        }
      } else if (key.escape || input === "q") {
        setMode("repl");
      }
      return;
    }
    // Review inbox (F22): preview / approve / return, single or multi-select.
    if (mode === "inbox") {
      if (key.upArrow) setInboxSel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setInboxSel((s) => Math.min(inboxDocs.length - 1, s + 1));
      else if (input === " ") {
        const d = inboxDocs[inboxSel];
        if (d)
          setInboxSelected((sel) => {
            const n = new Set(sel);
            n.has(d.rel) ? n.delete(d.rel) : n.add(d.rel);
            return n;
          });
      } else if (input === "a") setInboxSelected(new Set(inboxDocs.map((d) => d.rel)));
      else if (key.return) {
        const d = inboxDocs[inboxSel];
        if (d && project) openDoc(scoped(project), d.rel);
      } else if (input === "y") approveInbox();
      else if (input === "x") returnInbox();
      else if (input === "e") {
        const d = inboxDocs[inboxSel];
        if (d) {
          openExternally(d.path);
          append([{ text: `已用编辑器打开 ${d.rel}`, level: "ok" }]);
        }
      } else if (key.escape || input === "q") setMode("repl");
      return;
    }
    // Doc-doctor issue list (F19): Enter jumps to the offending doc.
    if (mode === "doctor") {
      if (key.upArrow) setDoctorSel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setDoctorSel((s) => Math.min(doctorIssues.length - 1, s + 1));
      else if (key.return) {
        const it = doctorIssues[doctorSel];
        if (it && it.rel && project) {
          setMode("repl");
          openDoc(scoped(project), it.rel);
        }
      } else if (key.escape || input === "q") {
        setMode("repl");
      }
      return;
    }
    // Outline / TOC navigation (F16): Enter jumps to the heading's line.
    if (mode === "outline") {
      if (key.upArrow) setOutlineSel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setOutlineSel((s) => Math.min(outlineHeadings.length - 1, s + 1));
      else if (key.return) {
        const h = outlineHeadings[outlineSel];
        setMode("repl");
        if (h) openDoc(outlineProj, outlineRel, h.line);
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
              const res = core.batchRemove(vault, scoped(project), rels);
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
      } else if (input === "o") {
        // o = pop the outline / TOC for the selected doc (F16).
        const d = browseDocs[browseSel];
        if (d) enterOutline(d.project, d.rel);
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
    // Command-word menu navigation.
    if (suggestions.length > 0) {
      if (key.downArrow) setSelected((s) => Math.min(s + 1, suggestions.length - 1));
      else if (key.upArrow) setSelected((s) => Math.max(s - 1, 0));
      else if (key.tab) {
        setValue(`/${suggestions[sel].name} `);
        setSelected(0);
      }
      return;
    }
    // Argument completion menu (F14): paths / types / statuses / projects.
    if (argList.length > 0) {
      if (key.downArrow) setArgSel((s) => Math.min(s + 1, argList.length - 1));
      else if (key.upArrow) setArgSel((s) => Math.max(s - 1, 0));
      else if (key.tab) completeArg(argList[aSel]);
      return;
    }
    // Ctrl-R: reverse history search.
    if (key.ctrl && input === "r") {
      reverseSearch();
      return;
    }
    // No menu open → ↑/↓ recall command history (F14).
    if (key.upArrow) recallHistory(-1);
    else if (key.downArrow) recallHistory(1);
  });

  /** Replace the in-progress argument token with the chosen completion (F14). */
  function completeArg(candidate: string): void {
    if (/\s$/.test(value)) {
      setValue(value + candidate + " ");
    } else {
      const parts = value.split(/\s+/);
      parts[parts.length - 1] = candidate;
      setValue(parts.join(" ") + " ");
    }
    setArgSel(0);
  }

  /** Recall command history: dir < 0 = older, dir > 0 = newer (F14). */
  function recallHistory(dir: number): void {
    if (cmdHist.length === 0) return;
    if (dir < 0) {
      const idx = histIdx < 0 ? cmdHist.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(idx);
      setValue(cmdHist[idx]);
    } else {
      if (histIdx < 0) return;
      const idx = histIdx + 1;
      if (idx >= cmdHist.length) {
        setHistIdx(-1);
        setValue("");
      } else {
        setHistIdx(idx);
        setValue(cmdHist[idx]);
      }
    }
  }

  /** Ctrl-R: step to the next older history entry containing the needle (F14). */
  function reverseSearch(): void {
    if (cmdHist.length === 0) return;
    const needle = (reverseNeedle ?? value).trim();
    const start = histIdx < 0 ? cmdHist.length - 1 : histIdx - 1;
    for (let i = start; i >= 0; i--) {
      if (!needle || cmdHist[i].includes(needle)) {
        setReverseNeedle(needle);
        setHistIdx(i);
        setValue(cmdHist[i]);
        return;
      }
    }
  }

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

  // Items for interactive search results: relevance-ordered, one row per doc,
  // with score + multiple highlighted snippets (F13).
  function resultItems(): SelectableItem[] {
    return resultHits.map((h, i) => {
      const snips = h.snippets.map((s) => (s.line ? `L${s.line} ${s.text}` : s.text)).join("  ");
      const loc = h.line ? `${h.rel}:${h.line}` : h.rel;
      // Cross-project (granted, read-only) hits are tagged with ↗ (F15).
      const tag = h.project && h.project !== project ? `[${h.project}↗] ` : "";
      return { id: `${h.project ?? ""}:${h.rel}:${i}`, label: `${tag}${loc}`, meta: `★${h.score} ${snips}` };
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

  // Mount: seed command history (F14) and optionally jump into import (F09).
  useEffect(() => {
    if (project) {
      try {
        setCmdHist(core.loadHistory(vault, scoped(project)));
      } catch {
        /* history is best-effort */
      }
    }
    if (initialImport) enterImport([initialImport.dir, ...(initialImport.tags ?? []).map((t) => "#" + t)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const quickList = mode === "quickopen" ? quickMatches() : [];

  // Homepage springboard: on a fresh REPL screen, surface pins + recents (F04).
  const atHome = mode === "repl" && value === "" && suggestions.length === 0 && history.length <= 1;
  const homePins = atHome && project ? core.getPins(vault, scoped(project)) : [];
  const homeRecents = atHome && project ? core.getRecents(vault, scoped(project)) : [];
  const homeFolders = atHome && project ? listFolders(vault, scoped(project)) : [];
  const showHome = homePins.length > 0 || homeRecents.length > 0 || homeFolders.length > 0;
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
            <Text dimColor>Space 选 · a 全选 · m 移动 · d 删除 · # 标 · s 状态 · Enter 预览 · o 大纲 · h 历史 · Esc 返回</Text>
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
      ) : mode === "graph" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">{project} · 关系图谱</Text>
          <SelectableList
            items={graphItems.map((l, i) => ({
              id: `${i}`,
              label: l.label,
            }))}
            activeIndex={graphSel}
          />
          <Box marginTop={1}>
            <Text dimColor>↑/↓ 选择 · Enter 打开节点 · Esc/q 返回</Text>
          </Box>
        </Box>
      ) : mode === "inbox" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">
            收件箱 · {project} ({inboxDocs.length} 篇待审 · agent 产出)
            {inboxSelected.size > 0 ? `  · 已选 ${inboxSelected.size}` : ""}
          </Text>
          <SelectableList
            items={inboxDocs.map((d) => ({
              id: d.rel,
              group: `${d.type}/`,
              label: d.name,
              meta: `${d.source ?? "agent"} · ${d.title}`,
            }))}
            activeIndex={inboxSel}
            selected={inboxSelected}
          />
          <Box marginTop={1}>
            <Text dimColor>Space 选 · a 全选 · Enter 预览 · y 通过 · x 退回 · e 编辑 · Esc 返回</Text>
          </Box>
        </Box>
      ) : mode === "doctor" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">
            体检报告 ({doctorIssues.filter((i) => i.severity === "error").length} error ·{" "}
            {doctorIssues.filter((i) => i.severity === "warn").length} warn ·{" "}
            {doctorIssues.filter((i) => i.severity === "info").length} info)
          </Text>
          <SelectableList
            items={doctorIssues.map((it, i) => ({
              id: `${i}`,
              marker: it.severity === "error" ? "✗ " : it.severity === "warn" ? "⚠ " : "ℹ ",
              label: `${it.rel ?? "(vault)"} — ${it.message}`,
              meta: `→ ${it.fix}`,
            }))}
            activeIndex={doctorSel}
          />
          <Box marginTop={1}>
            <Text dimColor>↑/↓ 选择 · Enter 跳到文档 · Esc/q 返回 · 修复用 docky doctor --fix</Text>
          </Box>
        </Box>
      ) : mode === "outline" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">大纲 · {outlineRel}</Text>
          <SelectableList
            items={outlineHeadings.map((h, i) => ({
              id: `${i}`,
              label: `${"  ".repeat(Math.max(0, h.level - 1))}${h.title}`,
              meta: `L${h.line}`,
            }))}
            activeIndex={outlineSel}
          />
          <Box marginTop={1}>
            <Text dimColor>↑/↓ 选择 · Enter 跳到该标题行 · Esc/q 返回</Text>
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
                  openDoc(scoped(project), d.rel);
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
              {homeFolders.length > 0 && (
                <Text color="yellow">{"📂 智能文件夹  " + homeFolders.map((f) => f.name).join(" · ")}</Text>
              )}
              <Text dimColor>{"/recent 打开 · /f <名称> 智能文件夹 · /pin <路径> 置顶"}</Text>
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
                setArgSel(0);
                setHistIdx(-1);
                setReverseNeedle(null);
              }}
              onSubmit={onSubmit}
              placeholder="输入命令,/ 看菜单 · ↑ 历史"
            />
          </Box>

          {suggestions.length > 0 && (
            <Box flexDirection="column" marginLeft={2}>
              {cmdStart > 0 && <Text dimColor>{`  ▲ 还有 ${cmdStart} 项`}</Text>}
              {suggestions.slice(cmdStart, cmdStart + MENU_ROWS).map((s, i) => {
                const idx = cmdStart + i;
                return (
                  <Box key={s.name} width={menuWidth} justifyContent="space-between">
                    <Text color={idx === sel ? "cyanBright" : "gray"}>
                      {idx === sel ? "▸ " : "  "}
                      {s.usage}
                    </Text>
                    <Text color={idx === sel ? "cyan" : "gray"} dimColor={idx !== sel}>
                      {s.desc}
                    </Text>
                  </Box>
                );
              })}
              {cmdStart + MENU_ROWS < suggestions.length && (
                <Text dimColor>{`  ▼ 还有 ${suggestions.length - cmdStart - MENU_ROWS} 项 · ${sel + 1}/${suggestions.length}`}</Text>
              )}
            </Box>
          )}

          {suggestions.length === 0 && argList.length > 0 && (
            <Box flexDirection="column" marginLeft={2}>
              {argStart > 0 && <Text dimColor>{`  ▲ 还有 ${argStart} 项`}</Text>}
              {argList.slice(argStart, argStart + MENU_ROWS).map((a, i) => {
                const idx = argStart + i;
                return (
                  <Text key={a} color={idx === aSel ? "cyanBright" : "gray"}>
                    {idx === aSel ? "▸ " : "  "}
                    {a}
                  </Text>
                );
              })}
              {argStart + MENU_ROWS < argList.length && (
                <Text dimColor>{`  ▼ 还有 ${argList.length - argStart - MENU_ROWS} 项 · ${aSel + 1}/${argList.length}`}</Text>
              )}
            </Box>
          )}

          <Box marginTop={suggestions.length > 0 || argList.length > 0 ? 0 : 1}>
            <Text dimColor>↑/↓ 选择/历史 · Tab 补全参数 · Ctrl-R 反搜 · Enter 执行</Text>
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
