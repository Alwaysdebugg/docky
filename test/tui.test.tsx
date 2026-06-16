import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import * as core from "../src/core.js";
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
  it("renders the welcome banner (no command list)", () => {
    const { lastFrame } = render(<App vault={vault} initialProject="p" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("docky");
    expect(frame).toContain("/help");
    expect(frame).toContain("[p]");
    // the full command catalogue should NOT be dumped on screen anymore
    expect(frame).not.toContain("/search");
    expect(frame).not.toContain("全文检索");
  });

  it("shows the command menu when typing /", async () => {
    const { lastFrame, stdin } = render(<App vault={vault} initialProject="p" />);
    stdin.write("/");
    await delay(50);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("▸");
    expect(frame).toContain("/list");
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
});
