import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "../src/core.js";
import { DOCKY_HOOK_ENTRIES, contextText, guardDecision, mergeHooks, unmergeHooks } from "../src/hooks.js";

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
    const inside = path.join(vault, "projects", "app", "spec", "x.md");
    expect(guardDecision(mk(inside), vault)).toBeNull();
  });

  it("allows Claude Code agent memory + skills under .claude", () => {
    const mem = "/Users/x/.claude/projects/-Users-x-code-app/memory";
    expect(guardDecision(mk(`${mem}/MEMORY.md`), vault)).toBeNull();
    expect(guardDecision(mk(`${mem}/feature-doc-citations.md`), vault)).toBeNull();
    // skill authoring files (SKILL.md + references) under .claude/**/skills/**
    expect(guardDecision(mk("/Users/x/.claude/skills/my-skill/SKILL.md"), vault)).toBeNull();
    expect(guardDecision(mk("/Users/x/.claude/plugins/p/skills/foo/reference.md"), vault)).toBeNull();
    // a 'memory'/'skills' dir NOT under .claude is still guarded
    expect(guardDecision(mk("/Users/x/code/app/memory/notes.md"), vault)).not.toBeNull();
    expect(guardDecision(mk("/Users/x/code/app/skills/design.md"), vault)).not.toBeNull();
  });

  it("allows Matt Pocock agent config under docs/agents/**", () => {
    expect(guardDecision(mk("/Users/x/code/app/docs/agents/issue-tracker.md"), vault)).toBeNull();
    expect(guardDecision(mk("/Users/x/code/app/docs/agents/triage-labels.md"), vault)).toBeNull();
    // a docs dir without the agents child is still guarded
    expect(guardDecision(mk("/Users/x/code/app/docs/design-notes.md"), vault)).not.toBeNull();
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
    core.writeDoc(vault, "app", "spec", "arch", "# Arch");
    const t = contextText(vault, repo, true);
    expect(t).toContain("当前项目: app");
    expect(t).toContain("spec/arch.md");
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

describe("unmergeHooks", () => {
  it("removes docky hooks and reports what was removed", () => {
    const { settings } = mergeHooks({}, DOCKY_HOOK_ENTRIES);
    const { settings: pruned, removed } = unmergeHooks(settings, DOCKY_HOOK_ENTRIES);
    expect(removed.length).toBe(2);
    // Both events pruned; the empty hooks map is dropped → leaves no scaffolding.
    expect(pruned.hooks).toBeUndefined();
  });

  it("is a clean inverse of mergeHooks (install → uninstall → {})", () => {
    const { settings } = mergeHooks({}, DOCKY_HOOK_ENTRIES);
    const { settings: pruned } = unmergeHooks(settings, DOCKY_HOOK_ENTRIES);
    expect(pruned).toEqual({});
  });

  it("is idempotent (second uninstall removes nothing)", () => {
    const { settings } = mergeHooks({}, DOCKY_HOOK_ENTRIES);
    unmergeHooks(settings, DOCKY_HOOK_ENTRIES);
    const { removed } = unmergeHooks(settings, DOCKY_HOOK_ENTRIES);
    expect(removed.length).toBe(0);
  });

  it("no-ops on settings that never had docky hooks", () => {
    const existing = { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] } };
    const { settings, removed } = unmergeHooks(existing, DOCKY_HOOK_ENTRIES);
    expect(removed.length).toBe(0);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("echo done");
  });

  it("preserves unrelated hooks while removing only docky's", () => {
    // A user-authored PreToolUse hook shares the event with docky's guard.
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }],
        Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
      },
    };
    const merged = mergeHooks(existing, DOCKY_HOOK_ENTRIES).settings;
    const { settings, removed } = unmergeHooks(merged, DOCKY_HOOK_ENTRIES);
    expect(removed.length).toBe(2);
    // docky's guard gone, the user's Bash linter and Stop hook remain.
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("my-linter");
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("echo done");
    expect(settings.hooks.SessionStart).toBeUndefined();
  });
});
