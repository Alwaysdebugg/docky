/**
 * Per-type document scaffolding templates (F06).
 *
 * Each doc type ships a built-in skeleton with `status: draft` + empty `tags`
 * (so a new doc enters the F03 lifecycle from birth). Users can override any
 * template by dropping `templates/<type>.md` into the vault; the built-in is
 * the fallback. Pure module — no core/Ink deps, so it is easily unit-tested.
 */
import fs from "node:fs";
import path from "node:path";
import { DOC_TYPES } from "./types.js";

/** Built-in default templates, keyed by doc type. `{{title}}`/`{{date}}` are
 *  substituted at scaffold time. */
export const BUILTIN_TEMPLATES: Record<string, string> = {
  design: `---
type: design
status: draft
tags: []
---

# {{title}}

## 背景

## 目标 / 非目标

## 方案

## 风险与取舍
`,
  plan: `---
type: plan
status: draft
tags: []
---

# {{title}}

## 目标

## 步骤

## 验收标准

## 风险
`,
  debug: `---
type: debug
status: draft
tags: []
---

# {{title}}

## 复现步骤

## 期望结果

## 实际结果

## 影响

## 根因与归属
`,
  "code-review": `---
type: code-review
status: draft
tags: []
---

# {{title}}

## 范围

## 阻断项 (blocking)

## 建议 (non-blocking)

## 结论
`,
  prompts: `---
type: prompts
status: draft
tags: []
---

# {{title}}

## 用途

## Prompt

## 示例输入 / 输出

## 注意事项
`,
};

function templatePath(vault: string, type: string): string {
  return path.join(vault, "templates", `${type}.md`);
}

/** Load a type's template: user override (vault/templates/<type>.md) first,
 *  else the built-in default. Falls back to a minimal skeleton for any type
 *  without a built-in. */
export function loadTemplate(vault: string, type: string): string {
  const override = templatePath(vault, type);
  if (fs.existsSync(override) && fs.statSync(override).isFile()) {
    return fs.readFileSync(override, "utf-8");
  }
  return BUILTIN_TEMPLATES[type] ?? `---\ntype: ${type}\nstatus: draft\ntags: []\n---\n\n# {{title}}\n`;
}

/** Substitute `{{title}}` and `{{date}}` placeholders. Unknown placeholders are
 *  left untouched. */
export function renderTemplate(template: string, vars: { title: string; date: string }): string {
  return template
    .replace(/\{\{\s*title\s*\}\}/g, vars.title)
    .replace(/\{\{\s*date\s*\}\}/g, vars.date);
}

/** Write the built-in templates into vault/templates/, without clobbering any
 *  the user has already customized. Called on `docky init`. */
export function writeDefaultTemplates(vault: string): void {
  const dir = path.join(vault, "templates");
  fs.mkdirSync(dir, { recursive: true });
  for (const t of DOC_TYPES) {
    const p = templatePath(vault, t);
    if (!fs.existsSync(p) && BUILTIN_TEMPLATES[t]) {
      fs.writeFileSync(p, BUILTIN_TEMPLATES[t], "utf-8");
    }
  }
}
