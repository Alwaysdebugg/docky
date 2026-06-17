import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "../src/core.js";
import { COMMANDS, executeCommand, parseListArgs, suggest } from "../src/commands.js";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docky-cmd-"));
  vault = path.join(tmp, "vault");
  core.initVault(vault, false);
  core.registerProject(vault, "p", path.join(tmp, "p"));
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("executeCommand", () => {
  it("/help lists every command", () => {
    const res = executeCommand(vault, "p", "/help");
    const text = res.output.map((o) => o.text).join("\n");
    for (const c of COMMANDS) expect(text).toContain(c.usage);
  });

  it("/init with an explicit name adds a project and switches to it", () => {
    const res = executeCommand(vault, null, `/init newproj ${path.join(tmp, "newproj")}`);
    expect(res.project).toBe("newproj");
    expect("newproj" in core.listProjects(vault)).toBe(true);
    expect(res.output.some((o) => o.level === "ok")).toBe(true);
  });

  it("/init with no args uses the current directory name", () => {
    const dir = path.join(tmp, "my-repo");
    fs.mkdirSync(dir, { recursive: true });
    const prev = process.cwd();
    try {
      process.chdir(dir);
      const res = executeCommand(vault, null, "/init");
      expect(res.project).toBe("my-repo");
      expect("my-repo" in core.listProjects(vault)).toBe(true);
    } finally {
      process.chdir(prev);
    }
  });

  it("/register still works as an alias of /init", () => {
    const res = executeCommand(vault, null, `/register aliased ${path.join(tmp, "aliased")}`);
    expect(res.project).toBe("aliased");
  });

  it("/use switches project", () => {
    core.registerProject(vault, "q", path.join(tmp, "q"));
    const res = executeCommand(vault, "p", "/use q");
    expect(res.project).toBe("q");
  });

  it("/use rejects unknown project", () => {
    const res = executeCommand(vault, "p", "/use nope");
    expect(res.output.some((o) => o.level === "err")).toBe(true);
  });

  it("/list and /search operate in scope", () => {
    core.writeDoc(vault, "p", "debug", "login", "# login\nsession lost");
    const list = executeCommand(vault, "p", "/list");
    expect(list.output.some((o) => o.text.includes("login"))).toBe(true);
    const search = executeCommand(vault, "p", "/search session");
    expect(search.output.some((o) => o.text.includes("debug/login.md"))).toBe(true);
  });

  it("commands without a project error clearly", () => {
    const res = executeCommand(vault, null, "/list");
    expect(res.output.some((o) => o.level === "err")).toBe(true);
  });

  it("/clear and /quit signal state", () => {
    expect(executeCommand(vault, "p", "/clear").clear).toBe(true);
    expect(executeCommand(vault, "p", "/quit").exit).toBe(true);
  });

  it("unknown command is reported, not thrown", () => {
    const res = executeCommand(vault, "p", "/bogus");
    expect(res.output.some((o) => o.level === "err")).toBe(true);
  });

  it("accepts commands without leading slash", () => {
    const res = executeCommand(vault, "p", "list");
    expect(res.output.length).toBeGreaterThan(0);
  });
});

describe("parseListArgs (F03)", () => {
  it("extracts type, --status, #tag, and --stale", () => {
    const f = parseListArgs(["design", "--status", "active", "#登录", "--stale"]);
    expect(f.type).toBe("design");
    expect(f.status).toBe("active");
    expect(f.tag).toBe("登录");
    expect(f.stale).toBe(true);
  });
  it("defaults to no filters", () => {
    expect(parseListArgs([])).toEqual({ stale: false });
  });
});

describe("lifecycle commands (F03)", () => {
  it("/status sets a doc's status and /list --status filters by it", () => {
    core.writeDoc(vault, "p", "design", "a", "# A");
    core.writeDoc(vault, "p", "plan", "b", "# B");
    const set = executeCommand(vault, "p", "/status design/a.md done");
    expect(set.output.some((o) => o.level === "ok")).toBe(true);
    expect(core.listDocs(vault, "p").find((d) => d.name === "a.md")!.status).toBe("done");
    const list = executeCommand(vault, "p", "/list --status done");
    const text = list.output.map((o) => o.text).join("\n");
    expect(text).toContain("a.md");
    expect(text).not.toContain("b.md");
  });

  it("/list hides archived docs by default", () => {
    core.writeDoc(vault, "p", "design", "kept", "# Kept");
    core.writeDoc(vault, "p", "debug", "old", "---\nstatus: archived\n---\n# Old");
    const text = executeCommand(vault, "p", "/list").output.map((o) => o.text).join("\n");
    expect(text).toContain("kept.md");
    expect(text).not.toContain("old.md");
  });

  it("/status rejects an invalid state", () => {
    core.writeDoc(vault, "p", "design", "a", "# A");
    const res = executeCommand(vault, "p", "/status design/a.md bogus");
    expect(res.output.some((o) => o.level === "err")).toBe(true);
  });
});

describe("scaffold command (F06)", () => {
  it("/new creates a draft document that shows up under --status draft", () => {
    const res = executeCommand(vault, "p", "/new debug 登录超时");
    expect(res.output.some((o) => o.level === "ok")).toBe(true);
    const list = executeCommand(vault, "p", "/list --status draft");
    expect(list.output.map((o) => o.text).join("\n")).toContain("登录超时.md");
  });

  it("/new without a type errors", () => {
    const res = executeCommand(vault, "p", "/new");
    expect(res.output.some((o) => o.level === "err")).toBe(true);
  });
});

describe("onboarding (F05)", () => {
  it("/whoami in an unregistered dir suggests how to register", () => {
    // process.cwd() (this repo) is not registered in the fresh temp vault.
    const res = executeCommand(vault, null, "/whoami");
    const text = res.output.map((o) => o.text).join("\n");
    expect(text).toContain("未注册");
    expect(text).toContain("docky register");
  });
});

describe("suggest", () => {
  it("filters by prefix while typing the command word", () => {
    expect(suggest("/l").map((c) => c.name)).toContain("list");
    expect(suggest("/li").every((c) => c.name.startsWith("li"))).toBe(true);
  });
  it("returns nothing once past the command word", () => {
    expect(suggest("/list ")).toHaveLength(0);
  });
  it("returns nothing for non-slash input", () => {
    expect(suggest("list")).toHaveLength(0);
  });
});
