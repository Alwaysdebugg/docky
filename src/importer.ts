/**
 * `docky import` — classify scattered Markdown files into the five doc types.
 *
 * Heuristics, in order of reliability (layers 1–3):
 *   1. frontmatter `type:`  → high confidence
 *   2. directory name match → high confidence
 *   3. filename token match → medium confidence
 *   else → unclassified (skipped on apply unless a default is chosen)
 *
 * Pure/deterministic and offline so it is fully unit-testable.
 */
import fs from "node:fs";
import path from "node:path";
import * as core from "./core.js";
import { parseFrontmatter } from "./core.js";
import { DOC_TYPES } from "./types.js";

export type Confidence = "high" | "medium" | "none";

export interface ClassifyResult {
  type: string | null;
  confidence: Confidence;
  reason: string;
}

export interface ImportItem extends ClassifyResult {
  src: string;
}

export interface ApplyResult {
  src: string;
  type: string;
  dest: string;
}

// Keywords per type, used for both directory-segment and filename-token matching.
const KEYWORDS: Record<string, string[]> = {
  design: ["design", "designs", "architecture", "arch", "adr", "rfc", "spec", "specs", "hld", "lld", "schema"],
  plan: ["plan", "plans", "planning", "roadmap", "todo", "todos", "tasks", "backlog", "requirements", "prd", "milestone", "milestones"],
  debug: ["debug", "bug", "bugs", "fix", "fixes", "issue", "issues", "troubleshoot", "troubleshooting", "postmortem", "postmortems", "rca", "incident", "incidents"],
  "code-review": ["review", "reviews", "code-review", "codereview", "cr", "pr", "pull-request", "pullrequest", "feedback"],
  prompts: ["prompt", "prompts", "system-prompt", "systemprompt", "llm", "instructions"],
};

// Standard repo docs that are not process docs — never imported.
const WHITELIST = /^(README|CHANGELOG|CONTRIBUTING|LICENSE|CODE_OF_CONDUCT|SECURITY|AGENTS|CLAUDE)/i;
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".cache", "vendor",
]);

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Classify a single file from its path + content. */
export function classifyDoc(filePath: string, content: string): ClassifyResult {
  // Layer 1: frontmatter type
  const fm = parseFrontmatter(content);
  const fmType = typeof fm.type === "string" ? fm.type.toLowerCase().trim() : "";
  if ((DOC_TYPES as readonly string[]).includes(fmType)) {
    return { type: fmType, confidence: "high", reason: "frontmatter type" };
  }

  // Layer 2: directory segment (exact match against keywords)
  const segs = tokens(path.dirname(filePath).split(path.sep).join(" "));
  for (const t of DOC_TYPES) {
    const hit = KEYWORDS[t].find((k) => segs.includes(k));
    if (hit) return { type: t, confidence: "high", reason: `目录 "${hit}"` };
  }

  // Layer 3: filename token (exact token match avoids false substrings like pr⊂prompt)
  const fileToks = tokens(path.basename(filePath, path.extname(filePath)));
  for (const t of DOC_TYPES) {
    const hit = KEYWORDS[t].find((k) => fileToks.includes(k));
    if (hit) return { type: t, confidence: "medium", reason: `文件名 "${hit}"` };
  }

  return { type: null, confidence: "none", reason: "无匹配信号" };
}

/** Recursively collect candidate .md files (skips build dirs and standard repo docs). */
export function scanMarkdown(dir: string, exclude?: string): string[] {
  const root = path.resolve(dir);
  const ex = exclude ? path.resolve(exclude) : null;
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (ex && (p === ex || p.startsWith(ex + path.sep))) continue; // skip the vault
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (/\.(md|markdown)$/i.test(e.name) && !WHITELIST.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** Build the import plan (no changes made). */
export function planImport(dir: string, exclude?: string): ImportItem[] {
  return scanMarkdown(dir, exclude).map((src) => {
    let content = "";
    try {
      content = fs.readFileSync(src, "utf-8");
    } catch {
      /* ignore */
    }
    return { src, ...classifyDoc(src, content) };
  });
}

/** Per-file input to applyImport. Accepts plan items as-is, or hand-resolved
 *  items carrying an overridden `type` and optional `tags` (F09 triage). */
export interface ImportInput {
  src: string;
  type: string | null;
  tags?: string[];
}

/**
 * Execute the plan: copy (or move) classified files into the project's vault.
 * Items with a null `type` are skipped. When `frontmatter` is set (or an item
 * carries tags), metadata frontmatter (type/tags) is written on archive (F09).
 * The whole batch lands as one commit (F08).
 */
export function applyImport(
  vault: string,
  project: string,
  items: ImportInput[],
  opts: { move?: boolean; frontmatter?: boolean } = {}
): ApplyResult[] {
  const results: ApplyResult[] = [];
  for (const it of items) {
    if (!it.type) continue; // skip unclassified
    const tags = it.tags && it.tags.length ? it.tags : undefined;
    const dest = core.addDoc(vault, project, it.type, it.src, {
      noCommit: true, // defer per-file commits → one revertable import commit
      withFrontmatter: Boolean(opts.frontmatter) || Boolean(tags),
      tags,
      branch: core.gitBranch(path.dirname(it.src)),
    });
    if (opts.move) {
      try {
        fs.unlinkSync(it.src);
      } catch {
        /* ignore */
      }
    }
    results.push({ src: it.src, type: it.type, dest });
  }
  if (results.length) core.autoCommitVault(vault, `import: ${results.length} 篇文档`);
  return results;
}
