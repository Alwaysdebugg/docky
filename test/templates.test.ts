import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUILTIN_TEMPLATES, loadTemplate, renderTemplate, staleSeededTemplates } from "../src/templates.js";
import { DOC_TYPES } from "../src/types.js";
import LEGACY_TEMPLATES from "./fixtures/legacy-templates.json";

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
    expect(loadTemplate(tmp, "tasks")).toBe(BUILTIN_TEMPLATES.tasks);
  });

  it("loadTemplate prefers a user override in vault/templates", () => {
    fs.mkdirSync(path.join(tmp, "templates"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "templates", "spec.md"), "custom {{title}}");
    expect(loadTemplate(tmp, "spec")).toBe("custom {{title}}");
  });

  it("staleSeededTemplates spots the templates docky itself seeded", () => {
    fs.mkdirSync(path.join(tmp, "templates"), { recursive: true });
    // A pre-taxonomy vault: docky seeded these at init, byte for byte.
    for (const [type, body] of Object.entries(LEGACY_TEMPLATES)) {
      fs.writeFileSync(path.join(tmp, "templates", `${type}.md`), body as string);
    }
    expect(staleSeededTemplates(tmp)).toEqual([
      "code-review.md",
      "debug.md",
      "design.md",
      "plan.md",
      "prompts.md",
    ]);
  });

  it("staleSeededTemplates never reports a template a human touched", () => {
    fs.mkdirSync(path.join(tmp, "templates"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "templates", "plan.md"), LEGACY_TEMPLATES.plan + "\n## 我加的一节\n");
    fs.writeFileSync(path.join(tmp, "templates", "design.md"), "完全自己写的");
    expect(staleSeededTemplates(tmp)).toEqual([]);
  });

  it("staleSeededTemplates is quiet on a vault with no templates dir", () => {
    expect(staleSeededTemplates(tmp)).toEqual([]);
  });

  it("a seeded plan.md would shadow the current built-in — which is why it is stale", () => {
    fs.mkdirSync(path.join(tmp, "templates"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "templates", "plan.md"), LEGACY_TEMPLATES.plan);
    expect(loadTemplate(tmp, "plan")).not.toContain("constitution 符合性"); // shadowed
    fs.rmSync(path.join(tmp, "templates", "plan.md"));
    expect(loadTemplate(tmp, "plan")).toContain("constitution 符合性"); // built-in reaches the user
  });
});
