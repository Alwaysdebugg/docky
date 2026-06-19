import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "../src/core.js";
import { evalFolder, getFolder, listFolders, parseQuery, removeFolder, saveFolder } from "../src/savedsearch.js";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docky-folders-"));
  vault = path.join(tmp, "vault");
  core.initVault(vault, false);
  core.registerProject(vault, "p", path.join(tmp, "p"));
  core.writeDoc(vault, "p", "design", "a", "---\nstatus: draft\ntags: [登录]\n---\n# A\nsession");
  core.writeDoc(vault, "p", "debug", "b", "---\nstatus: active\ntags: [登录]\n---\n# B\nsession lost");
  core.writeDoc(vault, "p", "plan", "c", "---\nstatus: done\n---\n# C\n无关");
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("saved searches / smart folders (F24)", () => {
  it("saves, lists, gets, and removes folders (persistent)", () => {
    saveFolder(vault, "p", "待办", "--status draft");
    saveFolder(vault, "p", "登录", "#登录 --status active");
    expect(listFolders(vault, "p").map((f) => f.name).sort()).toEqual(["待办", "登录"]);
    expect(getFolder(vault, "p", "待办")).toBe("--status draft");
    removeFolder(vault, "p", "待办");
    expect(listFolders(vault, "p").map((f) => f.name)).toEqual(["登录"]);
    expect(() => removeFolder(vault, "p", "待办")).toThrow();
  });

  it("parseQuery splits F03 filters from keywords (no new syntax)", () => {
    const q = parseQuery("design #登录 --status active session");
    expect(q.type).toBe("design");
    expect(q.tag).toBe("登录");
    expect(q.status).toBe("active");
    expect(q.keywords).toBe("session");
  });

  it("evalFolder evaluates filter-only and keyword queries", () => {
    expect(evalFolder(vault, "p", "--status draft").map((d) => d.name)).toEqual(["a.md"]);
    expect(evalFolder(vault, "p", "#登录 session").map((d) => d.name).sort()).toEqual(["a.md", "b.md"]);
  });

  it("is live — results track the library, not a snapshot", () => {
    const before = evalFolder(vault, "p", "--status draft").length;
    core.writeDoc(vault, "p", "design", "d2", "---\nstatus: draft\n---\n# D2");
    expect(evalFolder(vault, "p", "--status draft").length).toBe(before + 1);
  });

  it("rejects an empty name or query", () => {
    expect(() => saveFolder(vault, "p", "", "--status draft")).toThrow();
    expect(() => saveFolder(vault, "p", "x", "")).toThrow();
  });
});
