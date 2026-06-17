import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUILTIN_TEMPLATES, loadTemplate, renderTemplate, writeDefaultTemplates } from "../src/templates.js";
import { DOC_TYPES } from "../src/types.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docky-tpl-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("templates (F06)", () => {
  it("renders {{title}} and {{date}} placeholders", () => {
    expect(renderTemplate("# {{title}} — {{date}}", { title: "登录", date: "2026-06-17" })).toBe(
      "# 登录 — 2026-06-17"
    );
  });

  it("leaves unknown placeholders untouched", () => {
    expect(renderTemplate("{{title}} {{foo}}", { title: "X", date: "d" })).toBe("X {{foo}}");
  });

  it("every doc type ships a built-in template with draft status and a title slot", () => {
    for (const t of DOC_TYPES) {
      expect(BUILTIN_TEMPLATES[t]).toContain("status: draft");
      expect(BUILTIN_TEMPLATES[t]).toContain("tags: []");
      expect(BUILTIN_TEMPLATES[t]).toContain("{{title}}");
    }
  });

  it("loadTemplate falls back to the built-in when no override exists", () => {
    expect(loadTemplate(tmp, "debug")).toBe(BUILTIN_TEMPLATES.debug);
  });

  it("loadTemplate prefers a user override in vault/templates", () => {
    fs.mkdirSync(path.join(tmp, "templates"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "templates", "design.md"), "custom {{title}}");
    expect(loadTemplate(tmp, "design")).toBe("custom {{title}}");
  });

  it("writeDefaultTemplates seeds files without clobbering customizations", () => {
    fs.mkdirSync(path.join(tmp, "templates"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "templates", "design.md"), "MINE");
    writeDefaultTemplates(tmp);
    expect(fs.readFileSync(path.join(tmp, "templates", "design.md"), "utf-8")).toBe("MINE"); // preserved
    expect(fs.existsSync(path.join(tmp, "templates", "debug.md"))).toBe(true); // seeded
  });
});
