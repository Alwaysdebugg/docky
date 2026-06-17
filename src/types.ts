export const DOC_TYPES = ["design", "plan", "debug", "code-review", "prompts"] as const;
export type DocType = (typeof DOC_TYPES)[number];

/** Lifecycle states a document can carry in its frontmatter (F03). */
export const DOC_STATUSES = ["draft", "active", "done", "archived"] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

export interface ProjectMeta {
  paths: string[];
  link: boolean;
}

export type AutocommitMode = "auto" | "manual" | "off";

export interface Config {
  version: number;
  types: string[];
  projects: Record<string, ProjectMeta>;
  /** Days after which an active design/plan is flagged ⚠ stale (F03). */
  staleDays: number;
  /** Vault git auto-commit policy (F08): auto on every write, manual via
   *  `docky sync`, or off. */
  autocommit: AutocommitMode;
}

export interface ProjectContext {
  project: string;
  branch: string | null;
  root: string | null;
}

/** Result of detecting how a working directory maps to docky (F05 onboarding). */
export type ScopeDetection =
  | { kind: "registered"; project: string }
  | { kind: "unregistered-repo"; suggestedName: string; root: string }
  | { kind: "no-repo"; suggestedName: string }
  | { kind: "no-vault" };

export interface DocInfo {
  project: string;
  type: string;
  name: string;
  rel: string; // relative to project dir, e.g. "design/foo.md"
  title: string;
  path: string;
  status: DocStatus; // from frontmatter; defaults to "active" (F03)
  tags: string[]; // from frontmatter; defaults to [] (F03)
  mtime: number; // file modified time (ms epoch)
  stale: boolean; // active design/plan past the stale threshold (F03)
}

export interface SearchHit {
  rel: string;
  title: string;
  line: number;
  snippet: string;
}

/** User-facing error (bad scope, unknown project, invalid type, etc.). */
export class DockyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockyError";
  }
}
