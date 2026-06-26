import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "../src/core.js";
import { computeStats } from "../src/stats.js";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docky-stats-"));
  vault = path.join(tmp, "vault");
  core.initVault(vault, false);
  core.registerProject(vault, "p", path.join(tmp, "p"));
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("stats / dashboard (F21)", () => {
  beforeEach(() => {
    core.writeDoc(vault, "p", "design", "auth", "---\nstatus: active\ntags: [登录, 安全]\n---\n# 鉴权\n见 [[debug/login]]");
    core.writeDoc(vault, "p", "debug", "login", "---\nstatus: active\ntags: [登录]\n---\n# 登录排查\nbody");
    core.writeDoc(vault, "p", "plan", "old", "---\nstatus: done\ntags: [支付]\n---\n# 旧计划\n无链接");
    core.writeDoc(vault, "p", "debug", "gone", "---\nstatus: archived\n---\n# Gone");
  });

  it("aggregates type × status, stale, and status totals", () => {
    const s = computeStats(vault, "p");
    expect(s.total).toBe(4);
    const debugT = s.byType.find((t) => t.type === "debug")!;
    expect(debugT.active).toBe(1);
    expect(debugT.archived).toBe(1);
    expect(debugT.total).toBe(2);
    expect(s.statusTotals.active).toBe(2);
    expect(s.statusTotals.done).toBe(1);
    expect(s.statusTotals.archived).toBe(1);
  });

  it("ranks most-referenced docs and finds orphans (F12)", () => {
    const s = computeStats(vault, "p");
    expect(s.mostReferenced[0]).toEqual({ rel: "debug/login.md", count: 1 }); // auth → login
    expect(s.orphans).toContain("plan/old.md"); // no in/out links
    expect(s.orphans).not.toContain("design/auth.md"); // has an outlink
    expect(s.orphans).not.toContain("debug/login.md"); // has an inlink
  });

  it("computes tag heat (F03)", () => {
    const s = computeStats(vault, "p");
    expect(s.tagHeat[0]).toEqual({ tag: "登录", count: 2 });
  });

  it("summarizes health from the doctor (F19)", () => {
    expect(computeStats(vault, "p").health.error).toBe(0); // all docs have frontmatter + titles
    core.writeDoc(vault, "p", "design", "nofm", "# No FM\nbody"); // no frontmatter → an error
    expect(computeStats(vault, "p").health.error).toBeGreaterThanOrEqual(1);
  });
});
