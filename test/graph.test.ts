import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "../src/core.js";
import { buildGraph, toDot } from "../src/graph.js";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docky-graph-"));
  vault = path.join(tmp, "vault");
  core.initVault(vault, false);
  core.registerProject(vault, "p", path.join(tmp, "p"));
  core.writeDoc(vault, "p", "design", "auth", "# 鉴权\n见 [[debug/login]] 和 [[plan/rollout]]");
  core.writeDoc(vault, "p", "debug", "login", "# 登录\n见 [[design/auth]]");
  core.writeDoc(vault, "p", "plan", "rollout", "# 灰度\nbody");
  core.writeDoc(vault, "p", "debug", "orphan", "# 孤儿\n无链接");
  core.writeDoc(vault, "p", "design", "broken", "# 断\n见 [[ghost-zzz]]");
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("graph (F23)", () => {
  it("builds out/in edges and broken links per node", () => {
    const g = buildGraph(vault, "p");
    expect(g.nodes.get("design/auth.md")!.out.sort()).toEqual(["debug/login.md", "plan/rollout.md"]);
    expect(g.nodes.get("design/auth.md")!.in).toEqual(["debug/login.md"]);
    expect(g.nodes.get("design/broken.md")!.broken).toContain("ghost-zzz");
  });

  it("ranks hubs by in-degree", () => {
    const g = buildGraph(vault, "p");
    expect(g.hubs.some((h) => h.rel === "design/auth.md" && h.inDegree === 1)).toBe(true);
    expect(g.hubs.some((h) => h.rel === "debug/orphan.md")).toBe(false); // no in-links
  });

  it("groups connected docs into a cluster and lists isolates", () => {
    const g = buildGraph(vault, "p");
    const cluster = g.clusters.find((c) => c.includes("design/auth.md"))!;
    expect(cluster.sort()).toEqual(["debug/login.md", "design/auth.md", "plan/rollout.md"]);
    expect(g.isolates.sort()).toEqual(["debug/orphan.md", "design/broken.md"]);
  });

  it("exports Graphviz DOT", () => {
    const dot = toDot(buildGraph(vault, "p"));
    expect(dot).toContain("digraph docky");
    expect(dot).toContain('"design/auth.md" -> "debug/login.md"');
  });
});
