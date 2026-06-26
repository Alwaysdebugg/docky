import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "../src/core.js";
import { buildDocPage, buildIndexPage, exportSite, shareDoc } from "../src/export.js";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docky-export-"));
  vault = path.join(tmp, "vault");
  core.initVault(vault, false);
  core.registerProject(vault, "p", path.join(tmp, "p"));
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("export (F17)", () => {
  it("buildDocPage renders body, status/tags badges, resolved + broken links", () => {
    core.writeDoc(vault, "p", "design", "auth", "---\nstatus: draft\ntags: [登录]\n---\n# 鉴权改造\n见 [[debug/login]] 与 [[ghost-zzz]]\n\n正文段落");
    core.writeDoc(vault, "p", "debug", "login", "# 登录排查\nbody");
    const html = buildDocPage(vault, "p", "design/auth.md", "site");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("鉴权改造");
    expect(html).toContain("正文段落");
    expect(html).toContain("status-draft"); // F03 status badge
    expect(html).toContain("#登录"); // F03 tag
    expect(html).toContain('href="debug__login.html"'); // F12 link → in-site anchor
    expect(html).toContain("⚠"); // broken link flagged
  });

  it("exportSite writes an index plus per-doc pages with resolved cross-links", () => {
    core.writeDoc(vault, "p", "design", "a", "# A\n见 [[debug/b]]");
    core.writeDoc(vault, "p", "debug", "b", "# B\nbody");
    const out = path.join(tmp, "site");
    const r = exportSite(vault, "p", out);
    expect(r.count).toBe(2);
    expect(fs.existsSync(path.join(out, "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(out, "design__a.html"))).toBe(true);
    expect(fs.readFileSync(path.join(out, "index.html"), "utf-8")).toContain('href="design__a.html"');
    expect(fs.readFileSync(path.join(out, "design__a.html"), "utf-8")).toContain('href="debug__b.html"');
  });

  it("shareDoc writes a self-contained HTML file", () => {
    core.writeDoc(vault, "p", "design", "x", "# X\nhello world");
    const out = path.join(tmp, "x.html");
    expect(shareDoc(vault, "p", "design/x.md", out)).toBe(out);
    const html = fs.readFileSync(out, "utf-8");
    expect(html).toContain("<style>"); // inline CSS = self-contained
    expect(html).toContain("hello world");
  });

  it("hides archived from the site index and never leaves the project scope", () => {
    core.registerProject(vault, "other", path.join(tmp, "other"));
    core.writeDoc(vault, "other", "design", "secret", "# secret");
    core.writeDoc(vault, "p", "design", "kept", "# Kept");
    core.writeDoc(vault, "p", "debug", "gone", "---\nstatus: archived\n---\n# Gone");
    const idx = buildIndexPage(vault, "p");
    expect(idx).toContain("Kept");
    expect(idx).not.toContain("Gone"); // archived hidden
    expect(idx).not.toContain("secret"); // another project never included
  });
});
