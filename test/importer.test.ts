import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "../src/core.js";
import { applyImport, classifyDoc, planImport, scanMarkdown } from "../src/importer.js";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docky-import-"));
  vault = path.join(tmp, "vault");
  core.initVault(vault, false);
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("classifyDoc", () => {
  it("layer 1: frontmatter type wins (high)", () => {
    const r = classifyDoc("/x/whatever.md", "---\ntype: debug\n---\n# hi");
    expect(r).toMatchObject({ type: "debug", confidence: "high" });
  });

  it("layer 2: directory name (high)", () => {
    expect(classifyDoc("/repo/docs/design/x.md", "# x")).toMatchObject({ type: "design", confidence: "high" });
    expect(classifyDoc("/repo/review/x.md", "# x")).toMatchObject({ type: "code-review", confidence: "high" });
  });

  it("layer 3: filename token (medium)", () => {
    expect(classifyDoc("/repo/login-bug.md", "# x")).toMatchObject({ type: "debug", confidence: "medium" });
    expect(classifyDoc("/repo/arch-v2.md", "# x")).toMatchObject({ type: "design", confidence: "medium" });
    expect(classifyDoc("/repo/q3-roadmap.md", "# x")).toMatchObject({ type: "plan", confidence: "medium" });
  });

  it("does not false-match 'pr' inside 'prompt'", () => {
    const r = classifyDoc("/repo/prompt-template.md", "# x");
    expect(r.type).toBe("prompts"); // not code-review
  });

  it("unclassified when no signal", () => {
    expect(classifyDoc("/repo/random-notes.md", "# misc")).toMatchObject({ type: null, confidence: "none" });
  });
});

describe("scanMarkdown", () => {
  it("collects .md, skips node_modules and standard repo docs", () => {
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(path.join(repo, "design"), { recursive: true });
    fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(repo, "design", "a.md"), "# a");
    fs.writeFileSync(path.join(repo, "README.md"), "# readme");
    fs.writeFileSync(path.join(repo, "node_modules", "pkg", "doc.md"), "# dep");
    const found = scanMarkdown(repo);
    expect(found.some((f) => f.endsWith(path.join("design", "a.md")))).toBe(true);
    expect(found.some((f) => f.includes("node_modules"))).toBe(false);
    expect(found.some((f) => f.endsWith("README.md"))).toBe(false);
  });

  it("excludes the vault directory", () => {
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "design-note.md"), "# n");
    // vault lives elsewhere; scanning tmp should skip it when excluded
    const found = scanMarkdown(tmp, vault);
    expect(found.some((f) => f.startsWith(vault))).toBe(false);
  });
});

describe("planImport + applyImport", () => {
  it("plans then copies classified files into the project scope", () => {
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(path.join(repo, "debug"), { recursive: true });
    fs.writeFileSync(path.join(repo, "debug", "crash.md"), "# crash\nstack");
    fs.writeFileSync(path.join(repo, "misc.md"), "# misc"); // unclassified
    core.registerProject(vault, "app", repo);

    const items = planImport(repo, vault);
    expect(items.length).toBe(2);

    const classified = items.filter((i) => i.type);
    const results = applyImport(vault, "app", classified, {});
    expect(results.length).toBe(1);
    const docs = core.listDocs(vault, "app", "debug");
    expect(docs.some((d) => d.name === "crash.md")).toBe(true);
    // copy (default) keeps the original
    expect(fs.existsSync(path.join(repo, "debug", "crash.md"))).toBe(true);
  });

  it("move removes the original", () => {
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(path.join(repo, "design"), { recursive: true });
    const src = path.join(repo, "design", "arch.md");
    fs.writeFileSync(src, "# arch");
    core.registerProject(vault, "app", repo);
    const items = planImport(repo, vault).filter((i) => i.type);
    applyImport(vault, "app", items, { move: true });
    expect(fs.existsSync(src)).toBe(false);
  });
});

describe("triage overrides (F09)", () => {
  it("rescues an unclassified file via an explicit type override", () => {
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo, { recursive: true });
    const src = path.join(repo, "random-notes.md");
    fs.writeFileSync(src, "# notes");
    core.registerProject(vault, "app", repo);
    // planImport would classify this as null; the user retypes it to debug.
    applyImport(vault, "app", [{ src, type: "debug" }], { frontmatter: true });
    const docs = core.listDocs(vault, "app", "debug");
    expect(docs.some((d) => d.name === "random-notes.md")).toBe(true);
  });

  it("stamps tags into frontmatter, parsed back by F03", () => {
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo, { recursive: true });
    const src = path.join(repo, "legacy.md");
    fs.writeFileSync(src, "# legacy doc");
    core.registerProject(vault, "app", repo);
    applyImport(vault, "app", [{ src, type: "design", tags: ["legacy", "migrated"] }]);
    const doc = core.listDocs(vault, "app", "design").find((d) => d.name === "legacy.md")!;
    expect(doc.tags).toEqual(["legacy", "migrated"]); // F03 reads them back
    const raw = core.readDoc(vault, "app", "design/legacy.md");
    expect(raw).toContain("# legacy doc"); // body preserved below frontmatter
  });

  it("skips items whose type is still null (unclassified, not rescued)", () => {
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo, { recursive: true });
    const a = path.join(repo, "a.md");
    const b = path.join(repo, "b.md");
    fs.writeFileSync(a, "# a");
    fs.writeFileSync(b, "# b");
    core.registerProject(vault, "app", repo);
    const results = applyImport(vault, "app", [
      { src: a, type: "design" },
      { src: b, type: null }, // user left it unclassified → skipped
    ]);
    expect(results.length).toBe(1);
    expect(results[0].src).toBe(a);
  });
});
