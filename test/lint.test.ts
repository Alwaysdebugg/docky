import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "../src/core.js";
import { findOrphans, fixProject, lintProject, missingFrontmatter, missingTitle } from "../src/lint.js";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docky-lint-"));
  vault = path.join(tmp, "vault");
  core.initVault(vault, false);
  core.registerProject(vault, "p", path.join(tmp, "p"));
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("lint checks (F19)", () => {
  it("missingFrontmatter / missingTitle detect their conditions", () => {
    expect(missingFrontmatter("# Title\nbody")).toBe(true);
    expect(missingFrontmatter("---\nstatus: active\n---\n# T")).toBe(false);
    expect(missingTitle("just text, no heading")).toBe(true);
    expect(missingTitle("# Heading\nbody")).toBe(false);
    expect(missingTitle("---\ntitle: X\n---\nbody")).toBe(false);
  });

  it("findOrphans finds .md files outside the type dirs", () => {
    core.writeDoc(vault, "p", "design", "a", "---\nx: 1\n---\n# A");
    fs.writeFileSync(path.join(tmp, "vault", "projects", "p", "stray.md"), "# stray");
    const orphans = findOrphans(vault, "p");
    expect(orphans).toContain("stray.md");
    expect(orphans).not.toContain("design/a.md"); // proper docs are not orphans
  });
});

describe("lintProject + fixProject (F19)", () => {
  it("reports missing frontmatter (error), broken link + stale (warn), sorted error-first", () => {
    core.writeDoc(vault, "p", "design", "nofm", "# No FM\n见 [[ghost-zzz]]"); // no frontmatter + broken link
    core.writeDoc(vault, "p", "design", "old", "---\nstatus: active\n---\n# Old");
    fs.utimesSync(core.safePath(vault, "p", "design/old.md"), new Date(Date.now() - 60 * 86_400_000), new Date(Date.now() - 60 * 86_400_000));
    const issues = lintProject(vault, "p");
    expect(issues.some((i) => i.kind === "frontmatter" && i.severity === "error" && i.rel === "design/nofm.md")).toBe(true);
    expect(issues.some((i) => i.kind === "link" && i.rel === "design/nofm.md")).toBe(true);
    expect(issues.some((i) => i.kind === "stale" && i.rel === "design/old.md")).toBe(true);
    expect(issues[0].severity).toBe("error"); // severity-sorted
  });

  it("--fix adds frontmatter and clears the error without deleting files", () => {
    core.writeDoc(vault, "p", "design", "nofm", "# No FM\nbody text");
    const before = lintProject(vault, "p");
    expect(before.some((i) => i.kind === "frontmatter")).toBe(true);
    expect(fixProject(vault, "p", before)).toBe(1);
    expect(fs.existsSync(core.safePath(vault, "p", "design/nofm.md"))).toBe(true); // never deleted
    expect(lintProject(vault, "p").some((i) => i.kind === "frontmatter")).toBe(false); // fixed
    expect(core.readDoc(vault, "p", "design/nofm.md")).toContain("body text"); // body preserved
  });

  it("reports a healthy project as empty", () => {
    core.writeDoc(vault, "p", "design", "good", "---\nstatus: active\n---\n# Good\nbody");
    expect(lintProject(vault, "p")).toEqual([]);
  });
});
