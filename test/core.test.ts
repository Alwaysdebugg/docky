import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "../src/core.js";
import { parseFrontmatter } from "../src/core.js";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docky-test-"));
  vault = path.join(tmp, "vault");
  core.initVault(vault, false);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function mkRepo(p: string, branch = "main"): string {
  fs.mkdirSync(p, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", branch], { cwd: p });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: p });
  execFileSync("git", ["config", "user.name", "t"], { cwd: p });
  return p;
}

describe("init", () => {
  it("creates skeleton", () => {
    expect(fs.existsSync(path.join(vault, "projects"))).toBe(true);
    expect(fs.existsSync(path.join(vault, ".docky", "config.yaml"))).toBe(true);
  });
});

describe("register & resolve", () => {
  it("resolves project from repo root and subdir", () => {
    const repo = mkRepo(path.join(tmp, "proj-a"), "feature/login");
    core.registerProject(vault, "proj-a", repo);
    expect(core.resolveProject(vault, repo).project).toBe("proj-a");
    expect(core.resolveProject(vault, repo).branch).toBe("feature/login");
    const sub = path.join(repo, "src", "deep");
    fs.mkdirSync(sub, { recursive: true });
    expect(core.resolveProject(vault, sub).project).toBe("proj-a");
  });

  it("throws for unregistered dir (never global fallback)", () => {
    core.registerProject(vault, "proj-a", path.join(tmp, "proj-a"));
    const other = path.join(tmp, "elsewhere");
    fs.mkdirSync(other);
    expect(() => core.resolveProject(vault, other)).toThrow();
  });
});

describe("docs CRUD", () => {
  it("add, list, read", () => {
    core.registerProject(vault, "p", path.join(tmp, "p"));
    const src = path.join(tmp, "design.md");
    fs.writeFileSync(src, "# Title\n\nbody");
    core.addDoc(vault, "p", "design", src);
    const docs = core.listDocs(vault, "p");
    expect(docs.length).toBe(1);
    expect(docs[0].type).toBe("design");
    expect(docs[0].title).toBe("Title");
    expect(core.readDoc(vault, "p", docs[0].rel)).toContain("body");
  });

  it("rejects invalid type", () => {
    core.registerProject(vault, "p", path.join(tmp, "p"));
    const src = path.join(tmp, "x.md");
    fs.writeFileSync(src, "x");
    expect(() => core.addDoc(vault, "p", "nope", src)).toThrow();
  });

  it("move doc", () => {
    core.registerProject(vault, "p", path.join(tmp, "p"));
    core.writeDoc(vault, "p", "debug", "x", "# X");
    core.moveDoc(vault, "p", "debug/x.md", "design");
    expect(core.listDocs(vault, "p")[0].type).toBe("design");
  });
});

describe("scope isolation", () => {
  it("refuses path escaping project scope", () => {
    core.registerProject(vault, "p", path.join(tmp, "p"));
    core.registerProject(vault, "secret", path.join(tmp, "secret"));
    expect(() => core.readDoc(vault, "p", "../secret/design/leak.md")).toThrow(/escapes/);
  });
});

describe("search & index & frontmatter", () => {
  it("search finds content", () => {
    core.registerProject(vault, "p", path.join(tmp, "p"));
    core.writeDoc(vault, "p", "debug", "login", "# login bug\nsession lost on refresh");
    const hits = core.searchDocs(vault, "p", "session");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].rel).toBe("debug/login.md");
  });

  it("adds frontmatter", () => {
    core.registerProject(vault, "p", path.join(tmp, "p"));
    const src = path.join(tmp, "d.md");
    fs.writeFileSync(src, "# Hello\nbody");
    const dest = core.addDoc(vault, "p", "plan", src, { branch: "feature/x", withFrontmatter: true });
    const fm = parseFrontmatter(fs.readFileSync(dest, "utf-8"));
    expect(fm.project).toBe("p");
    expect(fm.type).toBe("plan");
    expect(fm.branch).toBe("feature/x");
  });

  it("generates index", () => {
    core.registerProject(vault, "p", path.join(tmp, "p"));
    core.writeDoc(vault, "p", "design", "a", "# A");
    const idx = core.generateIndex(vault, "p");
    const content = fs.readFileSync(idx, "utf-8");
    expect(content).toContain("## design");
    expect(content).toContain("[A]");
  });
});
