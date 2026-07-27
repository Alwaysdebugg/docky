import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "../src/core.js";
import { parseFrontmatter } from "../src/core.js";
import { loadConfig, saveConfig } from "../src/config.js";

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

/** rel of a smartWrite outcome that actually wrote/appended (narrows the union). */
function wroteRel(o: core.WriteOutcome): string {
  if (o.status === "written" || o.status === "appended") return o.rel;
  throw new Error(`expected a write, got: ${JSON.stringify(o)}`);
}

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
});

describe("tags & lifecycle (F03)", () => {
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
});

describe("vault versioning (F08)", () => {
  beforeEach(() => {
    core.initVault(vault, true); // upgrade the test vault to a git repo
    core.registerProject(vault, "p", path.join(tmp, "p"));
  });

  it("auto-commits on write (nothing left uncommitted)", () => {
    core.writeDoc(vault, "p", "design", "arch", "# Arch v1");
    expect(core.uncommittedCount(vault)).toBe(0); // committed
    core.writeDoc(vault, "p", "design", "arch", "# Arch v2\nnew line");
    expect(core.uncommittedCount(vault)).toBe(0); // the edit is committed too
  });

  it("does not commit when autocommit is off, but sync does", () => {
    saveConfig(vault, { ...loadConfig(vault), autocommit: "off" });
    core.writeDoc(vault, "p", "design", "x", "# X");
    expect(core.uncommittedCount(vault)).toBeGreaterThan(0); // not auto-committed
    const r = core.syncVault(vault);
    expect(r.committed).toBe(true);
    expect(core.uncommittedCount(vault)).toBe(0);
  });

  it("commits removals (recoverable from git history)", () => {
    core.writeDoc(vault, "p", "debug", "gone", "# Gone");
    core.removeDoc(vault, "p", "debug/gone.md");
    expect(core.uncommittedCount(vault)).toBe(0); // rm committed
    expect(core.listDocs(vault, "p").some((d) => d.name === "gone.md")).toBe(false);
  });

  it("git ops degrade to no-ops on a non-git vault", () => {
    const nogit = path.join(tmp, "nogit");
    core.initVault(nogit, false);
    core.registerProject(nogit, "q", path.join(tmp, "q"));
    core.writeDoc(nogit, "q", "design", "a", "# A");
    expect(core.uncommittedCount(nogit)).toBe(0); // not a repo → 0
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

describe("overwrite protection & delete", () => {
  beforeEach(() => core.registerProject(vault, "p", path.join(tmp, "p")));

  it("add refuses to overwrite without force; --force overwrites (prior version in git)", () => {
    core.writeDoc(vault, "p", "design", "arch", "# Arch OLD");
    const src = path.join(tmp, "arch.md");
    fs.writeFileSync(src, "# Arch NEW");
    expect(() =>
      core.addDoc(vault, "p", "design", src, { newName: "arch.md", failIfExists: true })
    ).toThrow(/已存在/);
    core.addDoc(vault, "p", "design", src, { newName: "arch.md", failIfExists: true, force: true });
    expect(core.readDoc(vault, "p", "design/arch.md")).toContain("NEW");
  });

  it("mv refuses to overwrite an existing target without force", () => {
    core.writeDoc(vault, "p", "debug", "dup", "# debug dup");
    core.writeDoc(vault, "p", "design", "dup", "# design dup");
    expect(() => core.moveDoc(vault, "p", "debug/dup.md", "design")).toThrow(/已存在/);
  });

  it("removeDoc deletes the file", () => {
    core.writeDoc(vault, "p", "debug", "login", "# login\nsecret");
    core.removeDoc(vault, "p", "debug/login.md");
    expect(core.listDocs(vault, "p").some((d) => d.name === "login.md")).toBe(false);
  });
});

describe("search relevance, snippets & highlight (F13)", () => {
  beforeEach(() => core.registerProject(vault, "p", path.join(tmp, "p")));

  it("ranks a title hit above a body-only hit", () => {
    core.writeDoc(vault, "p", "design", "session-design", "# session design\nabout caching");
    core.writeDoc(vault, "p", "debug", "misc", "# misc\nlost the session here once");
    const hits = core.searchDocs(vault, "p", "session");
    expect(hits[0].rel).toBe("design/session-design.md"); // title hit wins
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("returns multiple highlighted snippets per doc with line numbers", () => {
    core.writeDoc(vault, "p", "design", "arch", "# arch\ncreate session cache\nlater\nsession expiry policy");
    const hit = core.searchDocs(vault, "p", "session").find((h) => h.rel === "design/arch.md")!;
    expect(hit.snippets.length).toBe(2);
    expect(hit.snippets[0].line).toBe(2);
    expect(hit.snippets[1].line).toBe(4);
    expect(hit.snippets[0].text).toContain("「session」"); // hit highlighted
  });

  it("caps snippets per doc", () => {
    core.writeDoc(vault, "p", "debug", "many", "# many\nx\n".concat("session\n".repeat(10)));
    const hit = core.searchDocs(vault, "p", "session")[0];
    expect(hit.snippets.length).toBeLessThanOrEqual(3);
  });

  it("excludes archived docs and supports type filtering", () => {
    core.writeDoc(vault, "p", "debug", "live", "# live\nsession token");
    core.writeDoc(vault, "p", "debug", "dead", "---\nstatus: archived\n---\n# dead\nsession token");
    const hits = core.searchDocs(vault, "p", "session");
    expect(hits.some((h) => h.rel === "debug/live.md")).toBe(true);
    expect(hits.some((h) => h.rel === "debug/dead.md")).toBe(false);
  });

  it("fuzzy mode finds a doc by subsequence that exact misses", () => {
    core.writeDoc(vault, "p", "design", "authentication", "# authentication flow\nbody");
    expect(core.searchDocs(vault, "p", "authn")).toHaveLength(0); // exact: no match
    const fz = core.searchDocs(vault, "p", "authn", undefined, {}, { fuzzy: true });
    expect(fz.some((h) => h.rel === "design/authentication.md")).toBe(true);
  });
});

describe("governed cross-project access (F15)", () => {
  beforeEach(() => {
    core.registerProject(vault, "svc-a", path.join(tmp, "svc-a"));
    core.registerProject(vault, "platform", path.join(tmp, "platform"));
    core.registerProject(vault, "secret", path.join(tmp, "secret"));
    core.writeDoc(vault, "svc-a", "design", "gateway", "# gateway\n限流 design");
    core.writeDoc(vault, "platform", "design", "ratelimit", "# ratelimit\n限流 规范");
    core.writeDoc(vault, "platform", "debug", "note", "# note\n限流 debug note");
    core.writeDoc(vault, "secret", "design", "leak", "# leak\n限流 机密");
  });

  it("defaults to full isolation: no grant = only own project", () => {
    expect(core.resolveScopes(vault, "svc-a")).toEqual([{ project: "svc-a", readonly: false }]);
    const hits = core.searchAcross(vault, "svc-a", "限流");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.project === "svc-a")).toBe(true); // never another project
  });

  it("grant enables read-only cross search, tagged; ungranted stays invisible", () => {
    core.addGrant(vault, "svc-a", "platform");
    const hits = core.searchAcross(vault, "svc-a", "限流");
    expect(hits.some((h) => h.project === "svc-a" && h.readonly === false)).toBe(true);
    expect(hits.some((h) => h.project === "platform" && h.readonly === true)).toBe(true);
    expect(hits.some((h) => h.project === "secret")).toBe(false); // NEGATIVE: ungranted unseen
  });

  it("type-scoped grant exposes only the granted type", () => {
    core.addGrant(vault, "svc-a", "platform:design");
    const hits = core.searchAcross(vault, "svc-a", "限流");
    expect(hits.some((h) => h.project === "platform" && h.rel === "design/ratelimit.md")).toBe(true);
    expect(hits.some((h) => h.project === "platform" && h.rel.startsWith("debug/"))).toBe(false);
  });

  it("get_context --across aggregates granted items, tagged; ungranted excluded", () => {
    core.addGrant(vault, "svc-a", "platform");
    const ctx = core.buildContext(vault, "svc-a", { query: "限流", across: true });
    expect(ctx.items.some((i) => i.project === "platform")).toBe(true);
    expect(ctx.items.some((i) => i.project === "secret")).toBe(false);
    expect(ctx.note).toContain("跨项目");
  });

  it("grants are auditable and revocable", () => {
    core.addGrant(vault, "svc-a", "platform:design");
    expect(core.listGrants(vault)["svc-a"]).toEqual(["platform:design"]);
    core.revokeGrant(vault, "svc-a", "platform:design");
    expect(core.listGrants(vault)["svc-a"]).toBeUndefined();
  });

  it("rejects self-grant and unknown targets", () => {
    expect(() => core.addGrant(vault, "svc-a", "svc-a")).toThrow();
    expect(() => core.addGrant(vault, "svc-a", "nope")).toThrow();
  });

  it("a grant never enables cross-project writes or path traversal", () => {
    core.addGrant(vault, "svc-a", "platform");
    expect(() => core.readDoc(vault, "svc-a", "../platform/design/ratelimit.md")).toThrow(/escapes/);
    expect(() => core.writeDoc(vault, "svc-a", "design", "../../platform/x", "# x")).toThrow(/escapes/);
  });
});

describe("agent write metadata (F20)", () => {
  beforeEach(() => core.registerProject(vault, "p", path.join(tmp, "p")));

  it("stamps agent writes as source:agent / review:pending; human writes are not", () => {
    const rel = wroteRel(core.smartWrite(vault, "p", "debug", "agentdoc", "# Agent Doc\nbody"));
    core.writeDoc(vault, "p", "design", "humandoc", "# Human Doc\nbody"); // human path
    const agent = core.listDocs(vault, "p").find((d) => d.rel === rel)!;
    expect(agent.name).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-agentdoc\.md$/); // date-stamped (F20)
    expect(agent.source).toBe("agent");
    expect(agent.review).toBe("pending");
    expect(core.listDocs(vault, "p").find((d) => d.name === "humandoc.md")!.review).toBeUndefined();
  });
});

describe("smart write: dedupe / append / merge (F20)", () => {
  beforeEach(() => core.registerProject(vault, "p", path.join(tmp, "p")));

  it("textSimilarity scores near-identical high and unrelated low", () => {
    expect(core.textSimilarity("登录排查", "登录排查")).toBe(1);
    expect(core.textSimilarity("login debugging session", "login debug session")).toBeGreaterThan(0.5);
    expect(core.textSimilarity("登录排查", "支付退款方案")).toBeLessThan(0.2);
  });

  it("findSimilar surfaces near-duplicates, not unrelated docs", () => {
    core.writeDoc(vault, "p", "debug", "login-issue", "# 登录排查\nsession 丢失导致登录失败的排查记录");
    core.writeDoc(vault, "p", "design", "payments", "# 支付设计\n退款流程方案");
    const hits = core.findSimilar(vault, "p", { name: "登录排查", content: "# 登录排查\nsession 丢失导致登录失败的排查" });
    expect(hits.some((h) => h.rel === "debug/login-issue.md")).toBe(true);
    expect(hits.some((h) => h.rel === "design/payments.md")).toBe(false);
  });

  it("appendDoc appends a timestamped section, preserving the original", () => {
    core.writeDoc(vault, "p", "debug", "x", "# X\noriginal body");
    core.appendDoc(vault, "p", "debug/x.md", "new finding");
    const content = core.readDoc(vault, "p", "debug/x.md");
    expect(content).toContain("original body");
    expect(content).toContain("## 追加");
    expect(content).toContain("new finding");
  });

  it("smartWrite 'new' writes when there's no conflict", () => {
    const r = core.smartWrite(vault, "p", "debug", "fresh", "# Fresh\nbody");
    expect(r.status).toBe("written");
    if (r.status === "written") expect(r.rel).toMatch(/^debug\/\d{4}-\d{2}-\d{2}-\d{4}-fresh\.md$/);
    expect(core.listDocs(vault, "p").some((d) => d.name.endsWith("-fresh.md"))).toBe(true);
  });

  it("smartWrite 'new' refuses to silently overwrite a same-named doc", () => {
    core.writeDoc(vault, "p", "debug", "x", "# X\noriginal");
    const r = core.smartWrite(vault, "p", "debug", "x", "# X\nDIFFERENT");
    expect(r.status).toBe("duplicate_suspected");
    if (r.status === "duplicate_suspected") {
      expect(r.candidate.rel).toBe("debug/x.md");
      expect(r.candidate.similarity).toBe(1);
    }
    expect(core.readDoc(vault, "p", "debug/x.md")).toContain("original"); // NOT overwritten
  });

  it("smartWrite 'new' flags a near-duplicate that has a different name", () => {
    core.writeDoc(vault, "p", "debug", "login-issue", "# 登录排查\nsession 丢失导致登录失败的详细排查记录");
    const r = core.smartWrite(vault, "p", "debug", "session-issue", "# 登录排查\nsession 丢失导致登录失败的详细排查记录");
    expect(r.status).toBe("duplicate_suspected");
    if (r.status === "duplicate_suspected") expect(r.candidate.rel).toBe("debug/login-issue.md");
  });

  it("append / replace / merge are explicit modes", () => {
    core.writeDoc(vault, "p", "debug", "x", "# X\noriginal");
    expect(core.smartWrite(vault, "p", "debug", "x", "added note", "append").status).toBe("appended");
    expect(core.readDoc(vault, "p", "debug/x.md")).toContain("added note");
    expect(core.smartWrite(vault, "p", "debug", "x", "# X\nREPLACED", "replace").status).toBe("written");
    expect(core.readDoc(vault, "p", "debug/x.md")).toContain("REPLACED");
    const m = core.smartWrite(vault, "p", "debug", "x", "# X\nmerge candidate", "merge");
    expect(m.status).toBe("merge_preview");
    if (m.status === "merge_preview") expect(m.preview).toContain("REPLACED"); // existing side kept
  });
});

describe("agent date-stamped doc names (F20)", () => {
  beforeEach(() => core.registerProject(vault, "p", path.join(tmp, "p")));

  it("datePrefixed prepends YYYY-MM-DD-HHmm and is idempotent on already-dated names", () => {
    expect(core.datePrefixed("auth-redesign")).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-auth-redesign$/);
    expect(core.datePrefixed("2026-06-23-1430-auth")).toBe("2026-06-23-1430-auth"); // HHmm form kept
    expect(core.datePrefixed("2026-06-23-auth")).toBe("2026-06-23-auth"); // date-only form kept
  });

  it("smartWrite 'new' date-stamps the created file and stores it at the dated rel", () => {
    const r = core.smartWrite(vault, "p", "debug", "auth-redesign", "# Auth\nbody");
    expect(r.status).toBe("written");
    if (r.status === "written") {
      expect(r.rel).toMatch(/^debug\/\d{4}-\d{2}-\d{2}-\d{4}-auth-redesign\.md$/);
      expect(core.readDoc(vault, "p", r.rel)).toContain("body"); // lives at the dated rel
    }
  });

  it("does not double-stamp a name the agent already dated", () => {
    const r = core.smartWrite(vault, "p", "debug", "2026-01-02-0900-incident", "# Incident\nbody");
    expect(r.status).toBe("written");
    if (r.status === "written") expect(r.rel).toBe("debug/2026-01-02-0900-incident.md");
  });

  it("replace of an existing doc keeps its name (no re-stamp)", () => {
    core.writeDoc(vault, "p", "debug", "x", "# X\noriginal"); // human, undated
    const r = core.smartWrite(vault, "p", "debug", "x", "# X\nreplaced", "replace");
    expect(r.status).toBe("written");
    if (r.status === "written") expect(r.rel).toBe("debug/x.md"); // unchanged
    expect(core.readDoc(vault, "p", "debug/x.md")).toContain("replaced");
  });
});

describe("branch-scoped isolation (F56)", () => {
  function enableBranchScope(): void {
    const cfg = loadConfig(vault);
    cfg.branchScope = true;
    saveConfig(vault, cfg);
  }

  it("branchSegment sanitizes a branch into one safe path segment", () => {
    expect(core.branchSegment("main")).toBe("main");
    expect(core.branchSegment("feat/ultra-update")).toBe("feat-ultra-update");
    expect(core.branchSegment("release/1.2.x")).toBe("release-1.2.x");
    expect(core.branchSegment(null)).toBe(core.DEFAULT_BRANCH_BUCKET);
    expect(core.branchSegment("   ")).toBe(core.DEFAULT_BRANCH_BUCKET);
    // a branch named like a doc type is suffixed so it can't collide with a type dir
    expect(core.branchSegment("design")).toBe("design-branch");
  });

  it("scopedProject is the identity when off, a branch bucket when on", () => {
    expect(core.scopedProject(vault, "p", "main")).toBe("p"); // off by default
    enableBranchScope();
    expect(core.scopedProject(vault, "p", "main")).toBe("p/main");
    expect(core.scopedProject(vault, "p", "feat/x")).toBe("p/feat-x");
    expect(core.scopedProject(vault, "p", null)).toBe(`p/${core.DEFAULT_BRANCH_BUCKET}`);
  });

  it("an agent on branch A never reads branch B's docs", () => {
    enableBranchScope();
    const a = core.scopedProject(vault, "p", "branch-a");
    const b = core.scopedProject(vault, "p", "branch-b");
    core.writeDoc(vault, a, "design", "secret-a", "# A\nonly on A");
    core.writeDoc(vault, b, "design", "secret-b", "# B\nonly on B");

    expect(core.listDocs(vault, a).map((d) => d.name)).toEqual(["secret-a.md"]);
    expect(core.listDocs(vault, b).map((d) => d.name)).toEqual(["secret-b.md"]);
    // a doc from branch A is simply not in branch B's scope
    expect(() => core.readDoc(vault, b, "design/secret-a.md")).toThrow(/not found/i);
    // and they live in physically separate directories
    const base = path.join(vault, "projects", "p");
    expect(fs.existsSync(path.join(base, "branch-a", "design", "secret-a.md"))).toBe(true);
    expect(fs.existsSync(path.join(base, "branch-b", "design", "secret-a.md"))).toBe(false);
  });

  it("smartWrite dedupe, search, and buildContext stay within the branch bucket", () => {
    enableBranchScope();
    const a = core.scopedProject(vault, "p", "branch-a");
    const b = core.scopedProject(vault, "p", "branch-b");
    core.smartWrite(vault, a, "debug", "issue", "# 登录排查\nsession 丢失导致登录失败");
    // the same doc on branch B is NOT flagged as a duplicate of branch A's (isolated)
    const r = core.smartWrite(vault, b, "debug", "issue", "# 登录排查\nsession 丢失导致登录失败");
    expect(r.status).toBe("written");
    expect(core.searchDocs(vault, a, "session").length).toBe(1);
    expect(core.buildContext(vault, "p", { query: "session", branch: "branch-a" }).items.length).toBe(1);
    expect(core.buildContext(vault, "p", { query: "session", branch: "branch-b" }).items.length).toBe(1);
  });

  it("migrate moves legacy docs into the branch bucket, idempotently", () => {
    // legacy docs written before enabling branchScope (bare projects/<name>/<type>/)
    core.writeDoc(vault, "p", "design", "legacy", "# Legacy\nbody");
    core.writeDoc(vault, "p", "plan", "roadmap", "# Roadmap");
    enableBranchScope();
    // before migration the branch scope is empty (legacy docs are invisible)
    expect(core.listDocs(vault, core.scopedProject(vault, "p", "main")).length).toBe(0);

    const r = core.migrateBranchScope(vault, "p", "main");
    expect(r.bucket).toBe("main");
    expect(r.moved.sort()).toEqual(["design", "plan"]);
    expect(core.listDocs(vault, "p/main").map((d) => d.rel).sort()).toEqual([
      "design/legacy.md",
      "plan/roadmap.md",
    ]);
    // the legacy bare-level type dir is gone
    expect(fs.existsSync(path.join(vault, "projects", "p", "design", "legacy.md"))).toBe(false);
    // running it again moves nothing
    expect(core.migrateBranchScope(vault, "p", "main").moved).toEqual([]);
  });

  it("migrate never swallows an already-migrated branch bucket", () => {
    core.writeDoc(vault, "p", "design", "x", "# X");
    enableBranchScope();
    core.migrateBranchScope(vault, "p", "main"); // → projects/p/main/design/x.md
    // migrating a different branch must not move the existing 'main' bucket
    const r = core.migrateBranchScope(vault, "p", "feature");
    expect(r.moved).toEqual([]);
    expect(fs.existsSync(path.join(vault, "projects", "p", "main", "design", "x.md"))).toBe(true);
  });
});
