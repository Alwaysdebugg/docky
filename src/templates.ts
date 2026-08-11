/**
 * Per-type document scaffolding templates (F06).
 *
 * Each doc type ships a built-in skeleton with `status: draft` + empty `tags`
 * (so a new doc enters the F03 lifecycle from birth). Users can override any
 * template by dropping `templates/<type>.md` into the vault; the built-in is
 * the fallback. Pure module — no core/Ink deps, so it is easily unit-tested.
 *
 * `templates/` is opt-in: docky never seeds it. A file there means a human put
 * it there, so it always wins — and a built-in that later improves reaches every
 * vault instead of being shadowed forever by a copy seeded at `init` time.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Built-in default templates, keyed by doc type. `{{title}}`/`{{date}}` are
 *  substituted at scaffold time. */
export const BUILTIN_TEMPLATES: Record<string, string> = {
  constitution: `---
type: constitution
status: draft
tags: []
---

# {{title}}

## 原则

## 硬性约束(红线)

## 适用范围

## 例外与豁免
`,
  spec: `---
type: spec
status: draft
tags: []
---

# {{title}}

## 背景 / 要解决的问题

## 用户故事

## 功能需求

## 验收标准

## 非目标
`,
  plan: `---
type: plan
status: draft
tags: []
---

# {{title}}

## 目标 / 非目标

## 方案

## 步骤

## 风险与取舍

## constitution 符合性
`,
  tasks: `---
type: tasks
status: draft
tags: []
---

# {{title}}

## 任务清单

- [ ]

## 依赖与顺序

## 完成定义 (DoD)
`,
  adr: `---
type: adr
status: draft
tags: []
---

# {{title}}

## 状态

## 背景

## 决策

## 备选方案

## 后果
`,
  glossary: `---
type: glossary
status: draft
tags: []
---

# {{title}}

## 术语

| 术语 | 定义 | 备注 |
| --- | --- | --- |

## 新增记录
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

/**
 * sha256 of every template docky seeded into `templates/` back when `init` did
 * the seeding. A file matching one of these byte-for-byte was written by docky,
 * not by a human — which is the only way to tell a stale seeded copy from a real
 * customization. `plan` is the one that matters: its seeded copy predates the
 * taxonomy and would otherwise shadow the current built-in forever.
 */
export const SEEDED_TEMPLATE_HASHES: Record<string, string> = {
  design: "0ec0430ea45ab79fd64f4725a3fae283eba92752078e030922351c47e9b8bb43",
  plan: "84ab037b4b1688468e85b88d40e9662e39194be0ecfa3095e216a3bfc0ea8cac",
  debug: "f9af065843a2f8415cbf4ae98c7366fe597385eacb96b0aa3d75139c7ccc4969",
  "code-review": "3a8b3f9718983b3223d0033828185e8ac92daf64b02d936b95c762397025c730",
  prompts: "fbfa2013106b099adc337caa0a2c6b3c5c7f3b720b681a6a6cee6d023d1a7553",
};

/**
 * Template files in the vault that docky itself seeded and that no longer match
 * the taxonomy: either a retired type's template, or a stale copy of one that is
 * now shadowing a newer built-in. Returns paths relative to `templates/`.
 *
 * A file whose bytes differ from what docky wrote is a human's customization and
 * is never reported, however retired its type.
 */
export function staleSeededTemplates(vault: string): string[] {
  const dir = path.join(vault, "templates");
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  for (const [type, hash] of Object.entries(SEEDED_TEMPLATE_HASHES)) {
    const p = templatePath(vault, type);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
    const actual = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    if (actual === hash) out.push(`${type}.md`);
  }
  return out.sort();
}
