import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import * as core from "../src/core.js";
import { saveFolder } from "../src/savedsearch.js";
import { App } from "../src/tui.js";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docky-tui-"));
  vault = path.join(tmp, "vault");
  core.initVault(vault, false);
  core.registerProject(vault, "p", path.join(tmp, "p"));
  core.writeDoc(vault, "p", "debug", "login", "# login\nsession lost");
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("TUI", () => {
  it("renders the welcome logo banner (no command list)", () => {
    const { lastFrame } = render(<App vault={vault} initialProject="p" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("█"); // ASCII wordmark
    expect(frame).toContain("Docky");
    expect(frame).toContain("/help");
    expect(frame).toContain("[p]");
    // the full command catalogue should NOT be dumped on screen anymore
    expect(frame).not.toContain("/search");
    expect(frame).not.toContain("全文检索");
  });

  it("the command menu is a fixed-height scrolling window", async () => {
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/");
    await delay(40);
    let frame = lastFrame() ?? "";
    expect(frame).toContain("▼ 还有"); // more commands below the window
    expect(frame).not.toContain("▲ 还有"); // at the top — nothing hidden above yet
    // a long list must not render every command at once (window ≤ 16, total ~44)
    const menuRows = (frame.match(/▸|^ {2,}\//gm) ?? []).length;
    expect(menuRows).toBeLessThan(20);
    const DOWN = String.fromCharCode(27) + "[B";
    for (let i = 0; i < 45; i++) stdin.write(DOWN); // scroll to the bottom
    await delay(80);
    frame = lastFrame() ?? "";
    expect(frame).toContain("▲ 还有"); // window scrolled — items now hidden above
  });

  it("shows the command menu when typing /", async () => {
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/");
    await delay(50);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("▸");
    expect(frame).toContain("/list");
  });

  it("/clear emits the terminal clear sequence (real-terminal wipe)", async () => {
    // ink-testing-library does not emulate terminal screen-clearing, so we
    // verify the mechanism: /clear writes the clear-screen+scrollback escape.
    const { frames, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/help");
    await delay(20);
    stdin.write("\r");
    await delay(40);
    const clearSeq = String.fromCharCode(27) + "[2J";
    expect(frames.join("").includes(clearSeq)).toBe(false); // not yet
    stdin.write("/clear");
    await delay(20);
    stdin.write("\r");
    await delay(50);
    expect(frames.join("").includes(clearSeq)).toBe(true); // clear emitted
  });

  it("navigates the menu with the down arrow", async () => {
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/");
    await delay(40);
    const before = lastFrame() ?? "";
    const DOWN = String.fromCharCode(27) + "[B"; // ESC [ B
    stdin.write(DOWN);
    await delay(40);
    const after = lastFrame() ?? "";
    // The highlight marker ▸ should move to a different line after navigating.
    const markerLine = (f: string) => f.split("\n").findIndex((l) => l.includes("▸"));
    expect(markerLine(after)).toBeGreaterThan(markerLine(before));
  });

  it("/list opens a hierarchical browser grouped by type", async () => {
    core.writeDoc(vault, "p", "design", "arch", "# Arch");
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/list");
    await delay(20);
    stdin.write("\r"); // Enter -> enter browse mode
    await delay(60);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("design/"); // type header
    expect(frame).toContain("debug/");
    expect(frame).toContain("arch.md"); // file name shown
    expect(frame).toContain("login.md");
    expect(frame).toContain("Esc"); // browse hint
  });

  it("/projects opens a selectable project list and switches on Enter", async () => {
    core.registerProject(vault, "second", path.join(tmp, "second"));
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/projects");
    await delay(20);
    stdin.write("\r"); // enter projects selector
    await delay(50);
    let frame = lastFrame() ?? "";
    expect(frame).toContain("已注册项目");
    expect(frame).toContain("second");
    // move down and select -> switches active project (prompt shows [second] or [p])
    stdin.write(String.fromCharCode(27) + "[B");
    await delay(30);
    stdin.write("\r"); // pick highlighted project
    await delay(50);
    frame = lastFrame() ?? "";
    expect(frame).toMatch(/\[(p|second)\]/); // back to REPL with a project prompt
  });

  it("navigates documents with the down arrow in browse mode", async () => {
    core.writeDoc(vault, "p", "design", "arch", "# Arch");
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/list");
    await delay(20);
    stdin.write("\r");
    await delay(40);
    const markerLine = (f: string) => f.split("\n").findIndex((l) => l.includes("▸"));
    const before = markerLine(lastFrame() ?? "");
    stdin.write(String.fromCharCode(27) + "[B"); // down arrow
    await delay(40);
    const after = markerLine(lastFrame() ?? "");
    expect(after).toBeGreaterThan(before);
  });

  // F01 · interactive search results
  it("/search opens an interactive results list that jumps to the matched line", async () => {
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/search session");
    await delay(20);
    stdin.write("\r"); // run search -> enter results mode
    await delay(60);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("search: session"); // header with query + count
    expect(frame).toContain("debug/login.md:2"); // rel:line of the hit
    expect(frame).toContain("「session」"); // highlighted hit (F13)
    expect(frame).toContain("lost"); // snippet context
    expect(frame).toContain("跳到匹配行"); // results hint, not the static list
  });

  it("navigates search results with the down arrow", async () => {
    core.writeDoc(vault, "p", "design", "notes", "# notes\nsession token here");
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/search session");
    await delay(20);
    stdin.write("\r");
    await delay(50);
    const markerLine = (f: string) => f.split("\n").findIndex((l) => l.includes("▸"));
    const before = markerLine(lastFrame() ?? "");
    stdin.write(String.fromCharCode(27) + "[B"); // down arrow
    await delay(40);
    const after = markerLine(lastFrame() ?? "");
    expect(after).toBeGreaterThan(before);
  });

  it("empty search results report a friendly miss and stay in the REPL", async () => {
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/search zzznotfound");
    await delay(20);
    stdin.write("\r");
    await delay(50);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("无命中");
    expect(frame).not.toContain("跳到匹配行"); // did not enter results mode
  });

  // F02 · fuzzy quick-open palette
  it("/o opens the fuzzy quick-open palette and filters as you type", async () => {
    core.writeDoc(vault, "p", "design", "arch", "# Arch");
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/o");
    await delay(20);
    stdin.write("\r"); // open palette (no arg)
    await delay(50);
    let frame = lastFrame() ?? "";
    expect(frame).toContain("quick open"); // palette prompt
    expect(frame).toContain("arch.md");
    expect(frame).toContain("login.md");
    // type to fuzzy-filter down to just the design doc
    stdin.write("arch");
    await delay(50);
    frame = lastFrame() ?? "";
    expect(frame).toContain("arch.md");
    expect(frame).not.toContain("login.md");
  });

  it("Ctrl-P opens the quick-open palette from the REPL", async () => {
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("\x10"); // Ctrl-P
    await delay(50);
    expect(lastFrame() ?? "").toContain("quick open");
  });

  // F05 · onboarding & scope self-heal
  it("shows an onboarding card for an unregistered repo and R registers it", async () => {
    // No initial project; cwd is this git repo, unknown to the fresh temp vault.
    const { lastFrame, stdin } = render(<App vault={vault} initialProject={null} />);
    await delay(20);
    expect(lastFrame() ?? "").toContain("尚未注册");
    stdin.write("r"); // self-heal
    await delay(80);
    expect(lastFrame() ?? "").toContain("已注册并切换到");
  });

  it("shows a create-vault card when the vault does not exist", async () => {
    const fresh = path.join(tmp, "novault-app");
    const { lastFrame } = render(<App vault={fresh} initialProject={null} />);
    await delay(20);
    expect(lastFrame() ?? "").toContain("尚未初始化");
  });

  // F09 · interactive import triage
  it("/import opens the triage UI grouped by confidence", async () => {
    const scan = path.join(tmp, "scan");
    fs.mkdirSync(path.join(scan, "design"), { recursive: true });
    fs.writeFileSync(path.join(scan, "design", "arch.md"), "# arch");
    fs.writeFileSync(path.join(scan, "notes.md"), "# misc"); // unclassified
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/import " + scan);
    await delay(20);
    stdin.write("\r");
    await delay(80);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("导入三筛");
    expect(frame).toContain("HIGH");
    expect(frame).toContain("arch.md");
    expect(frame).toContain("未分类");
    expect(frame).toContain("notes.md");
  });

  // F24 · saved searches / smart folders
  it("homepage shows folders and /f opens one live", async () => {
    core.writeDoc(vault, "p", "design", "draft1", "---\nstatus: draft\n---\n# Draft");
    saveFolder(vault, "p", "待办", "--status draft");
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    await delay(20);
    expect(lastFrame() ?? "").toContain("智能文件夹"); // homepage surfaces folders
    expect(lastFrame() ?? "").toContain("待办");
    stdin.write("/f 待办");
    await delay(20);
    stdin.write("\r");
    await delay(60);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("📂 待办");
    expect(frame).toContain("draft1.md");
  });

  // F23 · relationship graph
  it("/graph shows the relationship graph and can open a node", async () => {
    core.writeDoc(vault, "p", "design", "auth", "# 鉴权\n见 [[debug/login.md]]"); // links to seeded login
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/graph");
    await delay(20);
    stdin.write("\r");
    await delay(60);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("关系图谱");
    expect(frame).toContain("login.md"); // hub or cluster member
  });

  // F22 · review inbox
  it("/inbox lists pending agent docs; y approves and clears it", async () => {
    core.smartWrite(vault, "p", "debug", "agentdoc", "# Agent Doc\nbody");
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/inbox");
    await delay(20);
    stdin.write("\r");
    await delay(60);
    expect(lastFrame() ?? "").toContain("收件箱");
    expect(lastFrame() ?? "").toContain("agentdoc.md");
    stdin.write("y"); // approve the current item
    await delay(60);
    expect(core.listPending(vault, "p").length).toBe(0);
  });

  // F21 · dashboard
  it("/dashboard shows the knowledge-base overview", async () => {
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/dashboard");
    await delay(20);
    stdin.write("\r");
    await delay(60);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("概览");
    expect(frame).toContain("debug"); // the type row for the seeded debug/login.md
  });

  // F19 · doc doctor
  it("/doctor lists health issues, jumpable", async () => {
    // beforeEach wrote debug/login.md with no frontmatter → a frontmatter error
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/doctor");
    await delay(20);
    stdin.write("\r");
    await delay(60);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("体检报告");
    expect(frame).toContain("login.md");
    expect(frame).toContain("frontmatter");
  });

  // F18 · config view
  it("/config shows preferences read-only", async () => {
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/config");
    await delay(20);
    stdin.write("\r");
    await delay(40);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("staleDays");
    expect(frame).toContain("autocommit");
  });

  // F16 · reading-view outline
  it("/outline pops a TOC with heading line numbers", async () => {
    core.writeDoc(vault, "p", "design", "doc", "# Top\n\n## 背景\n\n## 方案\n\n## 风险");
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/outline design/doc.md");
    await delay(20);
    stdin.write("\r");
    await delay(60);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("大纲");
    expect(frame).toContain("背景");
    expect(frame).toContain("风险");
    expect(frame).toContain("L7"); // 风险 is on line 7
  });

  // F14 · arg completion + history
  it("Tab completes a doc-path argument", async () => {
    core.writeDoc(vault, "p", "design", "architecture", "# arch");
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/open arch");
    await delay(40);
    expect(lastFrame() ?? "").toContain("design/architecture.md"); // arg suggestion shown
    stdin.write("\t"); // Tab completes the argument
    await delay(40);
    expect(lastFrame() ?? "").toContain("/open design/architecture.md");
  });

  it("↑ recalls commands from history into the prompt", async () => {
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/whoami");
    stdin.write("\r"); // submit → recorded in history, input cleared
    await delay(40);
    const UP = String.fromCharCode(27) + "[A";
    stdin.write(UP); // recall it back into the input
    await delay(40);
    // the prompt-prefixed form is unique to the input line (echoes lack "[p] ")
    expect(lastFrame() ?? "").toContain("[p] › /whoami");
  });

  // F12 · wikilinks
  it("/links opens a jumpable list of a doc's outlinks", async () => {
    core.writeDoc(vault, "p", "design", "auth", "# auth\n见 [[debug/login.md]]");
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/links design/auth.md");
    await delay(20);
    stdin.write("\r");
    await delay(60);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("🔗");
    expect(frame).toContain("login.md");
  });

  // F11 · multi-select batch
  it("multi-selects in the browser and batch-sets status", async () => {
    core.writeDoc(vault, "p", "debug", "a", "# A");
    core.writeDoc(vault, "p", "debug", "b", "# B");
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/list debug");
    await delay(20);
    stdin.write("\r"); // enter browse
    await delay(60);
    stdin.write("a"); // select all
    await delay(30);
    expect(lastFrame() ?? "").toContain("已选");
    stdin.write("s"); // batch status → batch-input prompt
    await delay(30);
    stdin.write("done");
    await delay(20);
    stdin.write("\r"); // apply
    await delay(80);
    expect(core.listDocs(vault, "p", "debug").every((d) => d.status === "done")).toBe(true);
  });

  it("batch-deletes the selection to trash with confirmation", async () => {
    core.writeDoc(vault, "p", "debug", "a", "# A");
    const { stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/list debug");
    await delay(20);
    stdin.write("\r");
    await delay(60);
    stdin.write("a"); // select all (login + a)
    await delay(30);
    stdin.write("d"); // batch delete → confirm
    await delay(30);
    stdin.write("y"); // confirm
    await delay(80);
    expect(core.listDocs(vault, "p", "debug").length).toBe(0);
    expect(core.listTrash(vault, "p").length).toBe(2);
  });

  // F10 · safe delete
  it("/rm asks for confirmation and trashes on y", async () => {
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/rm debug/login.md");
    await delay(20);
    stdin.write("\r");
    await delay(50);
    expect(lastFrame() ?? "").toContain("确认删除");
    stdin.write("y");
    await delay(60);
    expect(core.listDocs(vault, "p").some((d) => d.name === "login.md")).toBe(false);
    expect(core.listTrash(vault, "p").length).toBe(1);
  });

  it("/rm cancels on n (doc survives)", async () => {
    const { stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/rm debug/login.md");
    await delay(20);
    stdin.write("\r");
    await delay(40);
    stdin.write("n");
    await delay(50);
    expect(core.listDocs(vault, "p").some((d) => d.name === "login.md")).toBe(true);
  });

  it("triage rescues an unclassified file with t and imports it on a", async () => {
    const scan = path.join(tmp, "scan2");
    fs.mkdirSync(scan, { recursive: true });
    fs.writeFileSync(path.join(scan, "notes.md"), "# misc");
    const { stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/import " + scan);
    await delay(20);
    stdin.write("\r");
    await delay(60);
    stdin.write("t"); // assign a type to the unclassified item (+ selects it)
    await delay(30);
    stdin.write("a"); // apply
    await delay(80);
    expect(core.listDocs(vault, "p").some((d) => d.name === "notes.md")).toBe(true);
  });

  // F04 · recents & pins
  it("homepage surfaces pins and recents on a fresh screen", async () => {
    core.pin(vault, "p", "debug/login.md");
    core.recordOpen(vault, "p", "debug/login.md");
    const { lastFrame } = render(<App vault={vault} initialProject="p" />);
    await delay(20);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("📌 置顶");
    expect(frame).toContain("🕘 最近");
    expect(frame).toContain("debug/login.md");
  });

  it("opening a document records it into recents", async () => {
    const { stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/open debug/login.md");
    await delay(20);
    stdin.write("\r");
    await delay(60);
    expect(core.getRecents(vault, "p")).toContain("debug/login.md");
  });

  it("/recent opens a selectable list of pinned + recent docs", async () => {
    core.pin(vault, "p", "debug/login.md");
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/recent");
    await delay(20);
    stdin.write("\r");
    await delay(60);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("置顶");
    expect(frame).toContain("login.md");
    expect(frame).toContain("Esc"); // browse-style selectable hint
  });

  // F03 · tags & lifecycle in the browser
  it("/list --status filters the browser and shows status badges", async () => {
    core.writeDoc(vault, "p", "design", "arch", "---\nstatus: done\ntags: [核心]\n---\n# Arch");
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/list --status done");
    await delay(20);
    stdin.write("\r");
    await delay(60);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("arch.md"); // the done doc
    expect(frame).toContain("[done]"); // status badge
    expect(frame).toContain("#核心"); // tags shown
    expect(frame).not.toContain("login.md"); // active doc filtered out
  });

  it("quick-open empty query lists pinned docs first", async () => {
    core.writeDoc(vault, "p", "design", "arch", "# Arch");
    core.pin(vault, "p", "design/arch.md");
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/o");
    await delay(20);
    stdin.write("\r");
    await delay(50);
    const frame = lastFrame() ?? "";
    const idxArch = frame.indexOf("arch.md");
    const idxLogin = frame.indexOf("login.md");
    expect(idxArch).toBeGreaterThanOrEqual(0);
    expect(idxLogin).toBeGreaterThanOrEqual(0);
    expect(idxArch).toBeLessThan(idxLogin); // pinned arch sorts before login
  });
});
