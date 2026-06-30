import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "../src/core.js";
import { DOCKY_HOOK_ENTRIES, contextText, guardDecision, mergeHooks } from "../src/hooks.js";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docky-hooks-"));
  vault = path.join(tmp, "vault");
  core.initVault(vault, false);
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("guardDecision", () => {
  const mk = (filePath: string) => JSON.stringify({ tool_input: { file_path: filePath } });

  it("blocks a process .md written into a repo", () => {
    const out = guardDecision(mk("/Users/x/code/app/notes/design.md"), vault);
    expect(out).not.toBeNull();
    expect(out).toContain("write_doc");
    expect(out).toContain("\"permissionDecision\":\"deny\"");
  });

  it("allows non-markdown files", () => {
    expect(guardDecision(mk("/Users/x/code/app/src/index.ts"), vault)).toBeNull();
  });

  it("allows standard repo docs (README/CHANGELOG/…)", () => {
    expect(guardDecision(mk("/Users/x/code/app/README.md"), vault)).toBeNull();
    expect(guardDecision(mk("/Users/x/code/app/docs/CHANGELOG.md"), vault)).toBeNull();
  });

  it("allows writes inside the vault", () => {
    const inside = path.join(vault, "projects", "app", "design", "x.md");
    expect(guardDecision(mk(inside), vault)).toBeNull();
  });

  it("allows the Claude Code agent memory directory (…/.claude/**/memory/**)", () => {
    const mem = "/Users/x/.claude/projects/-Users-x-code-app/memory";
    expect(guardDecision(mk(`${mem}/MEMORY.md`), vault)).toBeNull();
    expect(guardDecision(mk(`${mem}/feature-doc-citations.md`), vault)).toBeNull();
    // a 'memory' dir NOT under .claude is still guarded
    expect(guardDecision(mk("/Users/x/code/app/memory/notes.md"), vault)).not.toBeNull();
  });

  it("allows when input has no path / is unparseable", () => {
    expect(guardDecision("", vault)).toBeNull();
    expect(guardDecision("not json", vault)).toBeNull();
    expect(guardDecision(JSON.stringify({ tool_input: {} }), vault)).toBeNull();
  });
});

describe("contextText", () => {
  it("always states the policy", () => {
    const t = contextText(vault, tmp, true);
    expect(t).toContain("docky 文档政策");
    expect(t).toContain("write_doc");
  });

  it("lists the current project's docs when registered", () => {
    const repo = path.join(tmp, "app");
    fs.mkdirSync(repo);
    core.registerProject(vault, "app", repo);
    core.writeDoc(vault, "app", "design", "arch", "# Arch");
    const t = contextText(vault, repo, true);
    expect(t).toContain("当前项目: app");
    expect(t).toContain("design/arch.md");
  });
});

describe("mergeHooks", () => {
  it("adds docky hooks to an empty settings object", () => {
    const { settings, added } = mergeHooks({}, DOCKY_HOOK_ENTRIES);
    expect(added.length).toBe(2);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("docky hooks context");
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Edit|Write");
  });

  it("is idempotent (no duplicates on second run)", () => {
    const first = mergeHooks({}, DOCKY_HOOK_ENTRIES);
    const second = mergeHooks(first.settings, DOCKY_HOOK_ENTRIES);
    expect(second.added.length).toBe(0);
    expect(second.settings.hooks.PreToolUse.length).toBe(1);
  });

  it("preserves existing unrelated hooks", () => {
    const existing = { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] } };
    const { settings } = mergeHooks(existing, DOCKY_HOOK_ENTRIES);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("echo done");
    expect(settings.hooks.SessionStart).toBeDefined();
  });
});
