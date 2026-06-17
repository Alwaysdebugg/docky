import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "../src/core.js";
import { parseFrontmatter } from "../src/core.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { applyImport } from "../src/importer.js";

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

describe("recents & pins (F04)", () => {
  beforeEach(() => {
    core.registerProject(vault, "p", path.join(tmp, "p"));
    core.writeDoc(vault, "p", "design", "arch", "# Arch");
    core.writeDoc(vault, "p", "debug", "login", "# login");
    core.writeDoc(vault, "p", "plan", "q3", "# Q3");
  });

  it("records opens most-recent-first, de-duped", () => {
    core.recordOpen(vault, "p", "design/arch.md");
    core.recordOpen(vault, "p", "debug/login.md");
    core.recordOpen(vault, "p", "design/arch.md"); // re-open bubbles to front
    expect(core.getRecents(vault, "p")).toEqual(["design/arch.md", "debug/login.md"]);
  });

  it("caps recents at 10 and persists across reloads", () => {
    for (let i = 0; i < 15; i++) {
      core.writeDoc(vault, "p", "design", `d${i}`, `# d${i}`);
      core.recordOpen(vault, "p", `design/d${i}.md`);
    }
    const recents = core.getRecents(vault, "p");
    expect(recents).toHaveLength(10);
    expect(recents[0]).toBe("design/d14.md"); // newest first
    // a fresh read (simulating a new session) sees the same persisted state
    expect(core.getRecents(vault, "p")).toEqual(recents);
  });

  it("pins persist and are idempotent; unpin removes", () => {
    core.pin(vault, "p", "design/arch.md");
    core.pin(vault, "p", "design/arch.md"); // dedupe
    expect(core.getPins(vault, "p")).toEqual(["design/arch.md"]);
    core.unpin(vault, "p", "design/arch.md");
    expect(core.getPins(vault, "p")).toEqual([]);
  });

  it("rejects pinning a non-existent doc", () => {
    expect(() => core.pin(vault, "p", "design/ghost.md")).toThrow(/not found/i);
  });

  it("normalizes equivalent rel forms to one entry", () => {
    core.pin(vault, "p", "design/arch.md");
    core.pin(vault, "p", "./design/arch.md");
    expect(core.getPins(vault, "p")).toEqual(["design/arch.md"]);
  });

  it("cleans up recents/pins when a doc is removed", () => {
    core.recordOpen(vault, "p", "debug/login.md");
    core.pin(vault, "p", "debug/login.md");
    core.removeDoc(vault, "p", "debug/login.md");
    expect(core.getRecents(vault, "p")).not.toContain("debug/login.md");
    expect(core.getPins(vault, "p")).not.toContain("debug/login.md");
  });

  it("cleans up the stale location when a doc is moved", () => {
    core.recordOpen(vault, "p", "debug/login.md");
    core.moveDoc(vault, "p", "debug/login.md", "design");
    expect(core.getRecents(vault, "p")).not.toContain("debug/login.md");
  });

  it("prunes entries whose files vanished out-of-band", () => {
    core.recordOpen(vault, "p", "plan/q3.md");
    fs.rmSync(core.safePath(vault, "p", "plan/q3.md")); // delete behind docky's back
    expect(core.getRecents(vault, "p")).not.toContain("plan/q3.md");
  });

  it("stores state inside project scope and refuses escaping rels", () => {
    core.registerProject(vault, "secret", path.join(tmp, "secret"));
    expect(() => core.pin(vault, "p", "../secret/x.md")).toThrow(/escapes/);
    // recordOpen must never throw, even on an escaping path
    expect(() => core.recordOpen(vault, "p", "../secret/x.md")).not.toThrow();
    expect(core.getRecents(vault, "p")).toHaveLength(0);
    expect(fs.existsSync(path.join(tmp, "vault", "projects", "p", ".docky-state.json")) ||
      core.getPins(vault, "p").length === 0).toBe(true);
  });

  it("does not list the state file as a document", () => {
    core.recordOpen(vault, "p", "design/arch.md"); // creates .docky-state.json
    const docs = core.listDocs(vault, "p");
    expect(docs.some((d) => d.name.includes(".docky-state"))).toBe(false);
  });
});

describe("tags, lifecycle & stale (F03)", () => {
  beforeEach(() => core.registerProject(vault, "p", path.join(tmp, "p")));

  it("parses status and tags from frontmatter, defaulting sensibly", () => {
    core.writeDoc(vault, "p", "design", "tagged", "---\nstatus: done\ntags: [登录, 安全]\n---\n\n# Tagged\nbody");
    core.writeDoc(vault, "p", "debug", "plain", "# Plain\nno frontmatter");
    const docs = core.listDocs(vault, "p");
    const tagged = docs.find((d) => d.name === "tagged.md")!;
    const plain = docs.find((d) => d.name === "plain.md")!;
    expect(tagged.status).toBe("done");
    expect(tagged.tags).toEqual(["登录", "安全"]);
    expect(tagged.title).toBe("Tagged");
    expect(plain.status).toBe("active"); // default when absent
    expect(plain.tags).toEqual([]);
  });

  it("filterDocs hides archived by default and honors status/tag", () => {
    core.writeDoc(vault, "p", "design", "a", "---\nstatus: active\ntags: [x]\n---\n# A");
    core.writeDoc(vault, "p", "plan", "b", "---\nstatus: done\n---\n# B");
    core.writeDoc(vault, "p", "debug", "c", "---\nstatus: archived\n---\n# C");
    const all = core.listDocs(vault, "p");
    expect(core.filterDocs(all).map((d) => d.name).sort()).toEqual(["a.md", "b.md"]); // archived hidden
    expect(core.filterDocs(all, { includeArchived: true })).toHaveLength(3);
    expect(core.filterDocs(all, { status: "archived" }).map((d) => d.name)).toEqual(["c.md"]);
    expect(core.filterDocs(all, { status: "done" }).map((d) => d.name)).toEqual(["b.md"]);
    expect(core.filterDocs(all, { tag: "x" }).map((d) => d.name)).toEqual(["a.md"]);
    expect(core.filterDocs(all, { tag: "#x" }).map((d) => d.name)).toEqual(["a.md"]); // leading # tolerated
  });

  it("flags an active design/plan as stale once it ages past staleDays", () => {
    core.writeDoc(vault, "p", "design", "old", "# Old");
    core.writeDoc(vault, "p", "debug", "olddebug", "# OldDebug");
    const past = new Date(Date.now() - 60 * 86_400_000); // 60 days ago (> default 30)
    fs.utimesSync(core.safePath(vault, "p", "design/old.md"), past, past);
    fs.utimesSync(core.safePath(vault, "p", "debug/olddebug.md"), past, past);
    const docs = core.listDocs(vault, "p");
    expect(docs.find((d) => d.name === "old.md")!.stale).toBe(true);
    expect(docs.find((d) => d.name === "olddebug.md")!.stale).toBe(false); // debug never stale
  });

  it("a done/archived doc is never stale", () => {
    core.writeDoc(vault, "p", "design", "finished", "---\nstatus: done\n---\n# Finished");
    const past = new Date(Date.now() - 90 * 86_400_000);
    fs.utimesSync(core.safePath(vault, "p", "design/finished.md"), past, past);
    expect(core.listDocs(vault, "p").find((d) => d.name === "finished.md")!.stale).toBe(false);
  });

  it("setStatus rewrites frontmatter while preserving the body", () => {
    core.writeDoc(vault, "p", "design", "s", "# S\n\nimportant body text");
    core.setStatus(vault, "p", "design/s.md", "done");
    const raw = core.readDoc(vault, "p", "design/s.md");
    expect(parseFrontmatter(raw).status).toBe("done");
    expect(raw).toContain("important body text");
    // and listDocs now reflects it
    expect(core.listDocs(vault, "p").find((d) => d.name === "s.md")!.status).toBe("done");
  });

  it("setStatus rejects invalid states and out-of-scope paths", () => {
    core.writeDoc(vault, "p", "design", "s", "# S");
    expect(() => core.setStatus(vault, "p", "design/s.md", "bogus")).toThrow(/Invalid status/i);
    core.registerProject(vault, "secret", path.join(tmp, "secret"));
    expect(() => core.setStatus(vault, "p", "../secret/x.md", "done")).toThrow(/escapes/);
  });

  it("search hides archived docs by default", () => {
    core.writeDoc(vault, "p", "debug", "live", "# live\nsession token");
    core.writeDoc(vault, "p", "debug", "dead", "---\nstatus: archived\n---\n# dead\nsession token");
    const hits = core.searchDocs(vault, "p", "session");
    expect(hits.some((h) => h.rel === "debug/live.md")).toBe(true);
    expect(hits.some((h) => h.rel === "debug/dead.md")).toBe(false);
  });

  it("index shows status badges, tags, and a ⚠ stale marker; hides archived", () => {
    core.writeDoc(vault, "p", "design", "old", "---\ntags: [登录]\n---\n# Old design");
    core.writeDoc(vault, "p", "plan", "shipped", "---\nstatus: done\n---\n# Shipped");
    core.writeDoc(vault, "p", "debug", "gone", "---\nstatus: archived\n---\n# Gone");
    const past = new Date(Date.now() - 60 * 86_400_000);
    fs.utimesSync(core.safePath(vault, "p", "design/old.md"), past, past);
    const idx = fs.readFileSync(core.generateIndex(vault, "p"), "utf-8");
    expect(idx).toContain("⚠ "); // stale marker on the aged design
    expect(idx).toContain("#登录"); // tags rendered
    expect(idx).toContain("[done]"); // status badge
    expect(idx).not.toContain("Gone"); // archived omitted
  });
});

describe("vault versioning (F08)", () => {
  beforeEach(() => {
    core.initVault(vault, true); // upgrade the test vault to a git repo
    core.registerProject(vault, "p", path.join(tmp, "p"));
  });

  it("auto-commits on write and exposes per-doc history", () => {
    core.writeDoc(vault, "p", "design", "arch", "# Arch v1");
    expect(core.uncommittedCount(vault)).toBe(0); // committed
    const log1 = core.logDoc(vault, "p", "design/arch.md");
    expect(log1.length).toBe(1);
    expect(log1[0].subject).toContain("design");
    core.writeDoc(vault, "p", "design", "arch", "# Arch v2\nnew line");
    expect(core.logDoc(vault, "p", "design/arch.md").length).toBe(2); // second commit for the edit
  });

  it("diffDoc shows changes against an earlier revision", () => {
    core.writeDoc(vault, "p", "design", "arch", "# Arch\nalpha");
    const first = core.logDoc(vault, "p", "design/arch.md")[0].hash;
    core.writeDoc(vault, "p", "design", "arch", "# Arch\nbeta");
    const diff = core.diffDoc(vault, "p", "design/arch.md", first);
    expect(diff).toContain("alpha"); // removed line
    expect(diff).toContain("beta"); // added line
  });

  it("does not commit when autocommit is off, but sync does", () => {
    saveConfig(vault, { ...loadConfig(vault), autocommit: "off" });
    core.writeDoc(vault, "p", "design", "x", "# X");
    expect(core.uncommittedCount(vault)).toBeGreaterThan(0); // not auto-committed
    const r = core.syncVault(vault);
    expect(r.committed).toBe(true);
    expect(core.uncommittedCount(vault)).toBe(0);
  });

  it("commits removals and preserves history (basis for F10 undo)", () => {
    core.writeDoc(vault, "p", "debug", "gone", "# Gone");
    core.removeDoc(vault, "p", "debug/gone.md");
    expect(core.uncommittedCount(vault)).toBe(0); // rm committed
    expect(core.logDoc(vault, "p", "debug/gone.md").length).toBeGreaterThanOrEqual(1);
  });

  it("folds a batch import into a single commit", () => {
    const a = path.join(tmp, "a.md");
    const b = path.join(tmp, "b.md");
    fs.writeFileSync(a, "# A\n");
    fs.writeFileSync(b, "# B\n");
    const before = core.logDoc(vault, "p", "design/a.md").length;
    applyImport(vault, "p", [
      { src: a, type: "design", confidence: "high", reason: "test" },
      { src: b, type: "design", confidence: "high", reason: "test" },
    ]);
    // both files landed in one commit
    expect(core.uncommittedCount(vault)).toBe(0);
    const logA = core.logDoc(vault, "p", "design/a.md");
    const logB = core.logDoc(vault, "p", "design/b.md");
    expect(logA.length).toBe(before + 1);
    expect(logA[0].hash).toBe(logB[0].hash); // same commit
    expect(logA[0].subject).toContain("import");
  });

  it("git ops degrade to no-ops on a non-git vault", () => {
    const nogit = path.join(tmp, "nogit");
    core.initVault(nogit, false);
    core.registerProject(nogit, "q", path.join(tmp, "q"));
    core.writeDoc(nogit, "q", "design", "a", "# A");
    expect(core.uncommittedCount(nogit)).toBe(0); // not a repo → 0
    expect(core.logDoc(nogit, "q", "design/a.md")).toEqual([]);
    expect(core.commitVault(nogit, "x")).toBe(false);
  });
});

describe("agent context bundle (F07)", () => {
  beforeEach(() => {
    core.registerProject(vault, "p", path.join(tmp, "p"));
    core.writeDoc(vault, "p", "design", "auth", "---\nstatus: active\ntags: [登录]\n---\n# 鉴权改造\n关于登录鉴权的设计方案。");
    core.writeDoc(vault, "p", "plan", "old", "---\nstatus: done\n---\n# 旧计划\n登录相关的旧计划。");
    core.writeDoc(vault, "p", "debug", "arc", "---\nstatus: archived\n---\n# 归档\n登录归档内容。");
  });

  it("returns ranked, archived-excluded items with excerpts and a note", () => {
    const ctx = core.buildContext(vault, "p", { query: "登录" });
    expect(ctx.items.length).toBe(2); // archived excluded
    expect(ctx.items[0].rel).toBe("design/auth.md"); // active design ranks above done plan
    expect(ctx.items.every((i) => i.status !== "archived")).toBe(true);
    expect(ctx.items[0].excerpt.length).toBeGreaterThan(0);
    expect(ctx.items[0].score).toBeGreaterThan(0);
    expect(ctx.note).toContain("archived");
  });

  it("truncates to a token budget and flags truncatedBy", () => {
    const ctx = core.buildContext(vault, "p", { query: "登录", budget: 5 });
    expect(ctx.items.length).toBe(1); // tiny budget → first item only, but always ≥1
    expect(ctx.truncatedBy).toBe("budget");
  });

  it("returns a project overview (no archived) when no query is given", () => {
    const ctx = core.buildContext(vault, "p");
    expect(ctx.items.some((i) => i.rel === "design/auth.md")).toBe(true);
    expect(ctx.items.some((i) => i.status === "archived")).toBe(false);
    expect(ctx.truncatedBy).toBe(null); // only 2 visible docs, under the cap
  });

  it("boosts pinned and recently-opened docs in the overview", () => {
    core.recordOpen(vault, "p", "plan/old.md");
    core.pin(vault, "p", "plan/old.md");
    const ctx = core.buildContext(vault, "p");
    expect(ctx.items[0].rel).toBe("plan/old.md"); // pin + recent outweighs the active design
  });

  it("never includes docs from another project's scope", () => {
    core.registerProject(vault, "other", path.join(tmp, "other"));
    core.writeDoc(vault, "other", "design", "secret", "# secret\n登录机密");
    const ctx = core.buildContext(vault, "p", { query: "登录" });
    expect(ctx.items.some((i) => i.rel.includes("secret"))).toBe(false);
  });
});

describe("scaffold from templates (F06)", () => {
  beforeEach(() => core.registerProject(vault, "p", path.join(tmp, "p")));

  it("creates a draft doc from the type template, wired into F03 lifecycle", () => {
    const dest = core.scaffold(vault, "p", "debug", "登录超时");
    const raw = fs.readFileSync(dest, "utf-8");
    expect(raw).toContain("# 登录超时");
    expect(raw).toContain("复现步骤"); // debug skeleton section
    const d = core.listDocs(vault, "p").find((x) => x.name === "登录超时.md")!;
    expect(d.status).toBe("draft");
    expect(d.title).toBe("登录超时");
  });

  it("generates a date-stamped name when none is given", () => {
    const dest = core.scaffold(vault, "p", "design");
    expect(path.basename(dest)).toMatch(/^design-\d{4}-\d{2}-\d{2}\.md$/);
  });

  it("rejects an invalid type", () => {
    expect(() => core.scaffold(vault, "p", "nope", "x")).toThrow();
  });

  it("seeds default templates into the vault on init", () => {
    expect(fs.existsSync(path.join(vault, "templates", "design.md"))).toBe(true);
    expect(fs.existsSync(path.join(vault, "templates", "prompts.md"))).toBe(true);
  });

  it("honors a user-overridden template", () => {
    fs.writeFileSync(path.join(vault, "templates", "design.md"), "---\ntype: design\nstatus: draft\n---\n# {{title}}\nTEAM RULES");
    const dest = core.scaffold(vault, "p", "design", "x");
    expect(fs.readFileSync(dest, "utf-8")).toContain("TEAM RULES");
  });
});

describe("onboarding & scope self-heal (F05)", () => {
  it("inferRepoName uses the git repo name, else the dir basename", () => {
    const repo = mkRepo(path.join(tmp, "my-app"));
    expect(core.inferRepoName(repo)).toBe("my-app");
    const plain = path.join(tmp, "plain-dir");
    fs.mkdirSync(plain);
    expect(core.inferRepoName(plain)).toBe("plain-dir");
  });

  it("detects a registered project", () => {
    const repo = mkRepo(path.join(tmp, "reg"));
    core.registerProject(vault, "reg", repo);
    expect(core.detectScope(vault, repo)).toEqual({ kind: "registered", project: "reg" });
  });

  it("detects an unregistered git repo with a suggested name", () => {
    const repo = mkRepo(path.join(tmp, "fresh-app"));
    const s = core.detectScope(vault, repo);
    expect(s.kind).toBe("unregistered-repo");
    if (s.kind === "unregistered-repo") {
      expect(s.suggestedName).toBe("fresh-app");
      expect(s.root.endsWith("fresh-app")).toBe(true);
    }
  });

  it("detects a non-git directory as no-repo", () => {
    const dir = path.join(tmp, "loose");
    fs.mkdirSync(dir);
    const s = core.detectScope(vault, dir);
    expect(s.kind).toBe("no-repo");
    if (s.kind === "no-repo") expect(s.suggestedName).toBe("loose");
  });

  it("detects a missing vault as no-vault (never a global fallback)", () => {
    const fresh = path.join(tmp, "novault");
    expect(core.detectScope(fresh, tmp).kind).toBe("no-vault");
  });
});

describe("safe delete, undo & overwrite protection (F10)", () => {
  beforeEach(() => core.registerProject(vault, "p", path.join(tmp, "p")));

  it("rm soft-deletes to trash and is restorable", () => {
    core.writeDoc(vault, "p", "debug", "login", "# login\nsecret");
    core.removeDoc(vault, "p", "debug/login.md");
    expect(core.listDocs(vault, "p").some((d) => d.name === "login.md")).toBe(false);
    const trash = core.listTrash(vault, "p");
    expect(trash.length).toBe(1);
    expect(trash[0].rel).toBe("debug/login.md");
    expect(core.restoreDoc(vault, "p", trash[0].name)).toBe("debug/login.md");
    expect(core.readDoc(vault, "p", "debug/login.md")).toContain("secret");
  });

  it("undo reverts the last rm", () => {
    core.writeDoc(vault, "p", "design", "a", "# A");
    core.removeDoc(vault, "p", "design/a.md");
    expect(core.undo(vault, "p")).toContain("rm");
    expect(core.listDocs(vault, "p").some((d) => d.name === "a.md")).toBe(true);
  });

  it("undo reverts the last mv", () => {
    core.writeDoc(vault, "p", "debug", "x", "# X");
    core.moveDoc(vault, "p", "debug/x.md", "design");
    core.undo(vault, "p");
    expect(core.listDocs(vault, "p", "debug").some((d) => d.name === "x.md")).toBe(true);
    expect(core.listDocs(vault, "p", "design").some((d) => d.name === "x.md")).toBe(false);
  });

  it("throws when there is nothing to undo", () => {
    expect(() => core.undo(vault, "p")).toThrow(/没有可撤销/);
  });

  it("add refuses to overwrite without force; --force backs up and undo restores old", () => {
    core.writeDoc(vault, "p", "design", "arch", "# Arch OLD");
    const src = path.join(tmp, "arch.md");
    fs.writeFileSync(src, "# Arch NEW");
    expect(() =>
      core.addDoc(vault, "p", "design", src, { newName: "arch.md", failIfExists: true })
    ).toThrow(/已存在/);
    core.addDoc(vault, "p", "design", src, { newName: "arch.md", failIfExists: true, force: true });
    expect(core.readDoc(vault, "p", "design/arch.md")).toContain("NEW");
    core.undo(vault, "p");
    expect(core.readDoc(vault, "p", "design/arch.md")).toContain("OLD"); // old content restored
  });

  it("mv refuses to overwrite an existing target without force", () => {
    core.writeDoc(vault, "p", "debug", "dup", "# debug dup");
    core.writeDoc(vault, "p", "design", "dup", "# design dup");
    expect(() => core.moveDoc(vault, "p", "debug/dup.md", "design")).toThrow(/已存在/);
  });

  it("rejects trash paths that escape project scope", () => {
    expect(() => core.restoreDoc(vault, "p", "../../etc/passwd")).toThrow();
  });
});

describe("batch operations (F11)", () => {
  beforeEach(() => {
    core.initVault(vault, true); // git, so we can assert single-commit batches
    core.registerProject(vault, "p", path.join(tmp, "p"));
    core.writeDoc(vault, "p", "debug", "a", "# A");
    core.writeDoc(vault, "p", "debug", "b", "# B");
    core.writeDoc(vault, "p", "debug", "c", "# C");
  });

  it("batchSetStatus updates the whole selection in one commit", () => {
    const res = core.batchSetStatus(vault, "p", ["debug/a.md", "debug/b.md", "debug/c.md"], "done");
    expect(res.ok.length).toBe(3);
    expect(core.listDocs(vault, "p").every((d) => d.status === "done")).toBe(true);
    expect(core.uncommittedCount(vault)).toBe(0);
    const la = core.logDoc(vault, "p", "debug/a.md");
    const lb = core.logDoc(vault, "p", "debug/b.md");
    expect(la[0].subject).toContain("batch status");
    expect(la[0].hash).toBe(lb[0].hash); // same single commit
  });

  it("batchMove relocates the selection to a new type in one commit", () => {
    const res = core.batchMove(vault, "p", ["debug/a.md", "debug/b.md"], "design");
    expect(res.ok.length).toBe(2);
    expect(core.listDocs(vault, "p", "design").length).toBe(2);
    expect(core.logDoc(vault, "p", "design/a.md")[0].subject).toContain("batch mv");
  });

  it("batchAddTags merges a tag across the selection", () => {
    core.batchAddTags(vault, "p", ["debug/a.md", "debug/b.md"], ["legacy"]);
    const docs = core.listDocs(vault, "p");
    expect(docs.find((d) => d.name === "a.md")!.tags).toContain("legacy");
    expect(docs.find((d) => d.name === "b.md")!.tags).toContain("legacy");
    expect(docs.find((d) => d.name === "c.md")!.tags).not.toContain("legacy");
  });

  it("batchRemove soft-deletes the selection to trash (recoverable)", () => {
    const res = core.batchRemove(vault, "p", ["debug/a.md", "debug/b.md"]);
    expect(res.ok.length).toBe(2);
    expect(core.listDocs(vault, "p").length).toBe(1); // only c remains
    expect(core.listTrash(vault, "p").length).toBe(2);
  });

  it("collects per-item errors without aborting the batch", () => {
    const res = core.batchSetStatus(vault, "p", ["debug/a.md", "debug/ghost.md"], "done");
    expect(res.ok).toEqual(["debug/a.md"]);
    expect(res.errors.length).toBe(1);
    expect(res.errors[0].rel).toBe("debug/ghost.md");
  });
});
