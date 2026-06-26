/**
 * Document health check (F19): scan a project for objective "bad smells" —
 * missing/empty frontmatter, no title, broken [[links]] (F12), stale docs
 * (F03), uncommitted changes (F08), and orphan files outside the type dirs.
 * Produces a structured issue list; `--fix` does only safe, idempotent repairs.
 */
import fs from "node:fs";
import path from "node:path";
import * as core from "./core.js";
import { DOC_TYPES } from "./types.js";

export type Severity = "error" | "warn" | "info";

export interface Issue {
  severity: Severity;
  rel: string | null; // doc path, or null for vault-level issues
  kind: "frontmatter" | "title" | "link" | "stale" | "uncommitted" | "orphan";
  message: string;
  fix: string; // human suggestion
  fixable: boolean; // auto-fixable by fixProject
}

// --- pure checks (unit-testable) ------------------------------------------- //

/** True when the document has no frontmatter block at all. */
export function missingFrontmatter(content: string): boolean {
  return Object.keys(core.parseFrontmatter(content)).length === 0;
}

/** True when there's neither a frontmatter `title` nor a `# ` heading. */
export function missingTitle(content: string): boolean {
  const fm = core.parseFrontmatter(content);
  if (fm.title) return false;
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
  return !/^#{1,6}\s+\S/m.test(body);
}

function readSafe(p: string): string {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

/** Markdown files under the project dir that live OUTSIDE the type folders. */
export function findOrphans(vault: string, project: string): string[] {
  const base = core.projectDir(vault, project);
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue; // .trash, .docky-*, etc.
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (prefix === "" && (DOC_TYPES as readonly string[]).includes(e.name)) continue; // type dir → listDocs owns it
        walk(path.join(dir, e.name), rel);
      } else if (e.name.endsWith(".md") && e.name !== "INDEX.md") {
        if (!(DOC_TYPES as readonly string[]).includes(rel.split("/")[0])) out.push(rel);
      }
    }
  };
  walk(base, "");
  return out;
}

// --- orchestration --------------------------------------------------------- //

export function lintProject(vault: string, project: string): Issue[] {
  const issues: Issue[] = [];
  for (const d of core.listDocs(vault, project)) {
    const content = readSafe(d.path);
    if (missingFrontmatter(content)) {
      issues.push({ severity: "error", rel: d.rel, kind: "frontmatter", message: "缺 frontmatter", fix: "--fix 可补默认 frontmatter", fixable: true });
    }
    if (missingTitle(content)) {
      issues.push({ severity: "warn", rel: d.rel, kind: "title", message: "无标题(回退到文件名)", fix: "加 # 标题或 frontmatter title", fixable: false });
    }
    if (d.stale) {
      issues.push({ severity: "warn", rel: d.rel, kind: "stale", message: `陈旧(active 的 ${d.type})`, fix: "/status archived 或更新内容", fixable: false });
    }
    try {
      for (const b of core.getLinks(vault, project, d.rel).broken) {
        issues.push({ severity: "warn", rel: d.rel, kind: "link", message: `断链 [[${b}]]`, fix: "修正或移除链接(F12)", fixable: false });
      }
    } catch {
      /* links best-effort */
    }
  }
  for (const orphan of findOrphans(vault, project)) {
    issues.push({ severity: "warn", rel: orphan, kind: "orphan", message: "游离文件(不在类型目录内)", fix: "docky mv 归入某类型目录", fixable: false });
  }
  const uncommitted = core.uncommittedCount(vault);
  if (uncommitted > 0) {
    issues.push({ severity: "info", rel: null, kind: "uncommitted", message: `${uncommitted} 处未提交改动`, fix: "docky sync", fixable: true });
  }
  const order: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Apply only safe, idempotent fixes: add frontmatter (→ status: active),
 *  rebuild INDEX, and commit. Never deletes files. Returns the fix count. */
export function fixProject(vault: string, project: string, issues: Issue[]): number {
  let fixed = 0;
  for (const i of issues) {
    if (i.kind === "frontmatter" && i.fixable && i.rel) {
      try {
        core.setStatus(vault, project, i.rel, "active"); // gray-matter adds the frontmatter block
        fixed++;
      } catch {
        /* skip unfixable */
      }
    }
  }
  core.generateIndex(vault, project);
  core.commitVault(vault, "doctor --fix: 补 frontmatter / 重建 INDEX");
  return fixed;
}
