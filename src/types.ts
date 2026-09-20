export const DOC_TYPES = ["constitution", "spec", "plan", "tasks", "adr", "glossary"] as const;
export type DocType = (typeof DOC_TYPES)[number];

/** How much review a doc type earns before it can be trusted. */
export const REVIEW_LEVELS = ["on-write", "always", "spot-check", "new-entries-only", "none"] as const;
export type ReviewLevel = (typeof REVIEW_LEVELS)[number];

export interface DocTypeSpec {
  /** What belongs in this bucket — so an agent files a doc under the right type. */
  purpose: string;
  /** Machine-readable review level. */
  review: ReviewLevel;
  /** The one-line rule that level stands for (agent-facing). */
  policy: string;
}

/**
 * The single source of truth for the doc taxonomy and its review policy. The
 * CLI help, the MCP tool descriptions and the SessionStart hook all render from
 * this map, so the rules an agent sees can never drift between surfaces.
 */
export const DOC_TYPE_SPECS: Record<DocType, DocTypeSpec> = {
  constitution: {
    purpose: "项目的硬性原则与红线,长期不变",
    review: "on-write",
    policy: "写的时候审透,之后几乎不看",
  },
  spec: {
    purpose: "需求与验收标准 —— 做成什么样才算做完",
    review: "always",
    policy: "必审(每次)",
  },
  plan: {
    purpose: "实现方案、设计与步骤",
    review: "spot-check",
    policy: "抽检,重点看有没有违反 constitution",
  },
  tasks: {
    purpose: "可执行的任务清单与拆解",
    review: "none",
    policy: "不审 —— 撞墙自然会反馈",
  },
  adr: {
    purpose: "架构决策记录:决定了什么、为什么、代价是什么",
    review: "always",
    policy: "必审",
  },
  glossary: {
    purpose: "术语表:项目内统一的名词与定义",
    review: "new-entries-only",
    policy: "只审新增条目",
  },
};

/**
 * Ranking bump a type earns in the context bundle (F07), derived from its review
 * level rather than stored alongside it: what an agent must always re-read is
 * also what it should see first, and a derived value cannot drift from `review`.
 */
const REVIEW_WEIGHT: Record<ReviewLevel, number> = {
  "on-write": 2, // constitution — durable and authoritative
  always: 2, // spec / adr — durable and authoritative
  "spot-check": 1, // plan — useful, but in flight
  "new-entries-only": 1, // glossary — useful, mostly stable
  none: 0, // tasks — throwaway
};

/** Context-ranking weight for a doc type; 0 for anything outside the taxonomy. */
export function docTypeWeight(type: string): number {
  const spec = DOC_TYPE_SPECS[type as DocType];
  return spec ? REVIEW_WEIGHT[spec.review] : 0;
}

/** "constitution | spec | plan | tasks | adr | glossary" — for arg hints. */
export const DOC_TYPE_HINT = DOC_TYPES.join(" | ");

/** Compact one-line review rules, e.g. "spec:必审(每次);plan:抽检…". */
export const REVIEW_HINT = DOC_TYPES.map((t) => `${t}:${DOC_TYPE_SPECS[t].policy}`).join(";");

/** One line per type — what it holds and how much review it earns. */
export function docTypeCatalog(prefix = "- "): string[] {
  return DOC_TYPES.map((t) => `${prefix}${t} — ${DOC_TYPE_SPECS[t].purpose};审查:${DOC_TYPE_SPECS[t].policy}`);
}

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
  /** Vault git auto-commit policy (F08): auto on every write, manual via
   *  `docky sync`, or off. */
  autocommit: AutocommitMode;
  /** Read-only cross-project grants (F15): project → ["other", "other:type"]. */
  grants: Record<string, string[]>;
  /** Reading-view render preferences (F16; managed by F18 later). */
  render: { width?: number; theme: "dark" | "none" };
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
  rel: string; // relative to project dir, e.g. "spec/foo.md"
  title: string;
  path: string;
  status: DocStatus; // from frontmatter; defaults to "active" (F03)
  tags: string[]; // from frontmatter; defaults to [] (F03)
  mtime: number; // file modified time (ms epoch)
}

export interface Snippet {
  line: number;
  text: string; // highlighted (matches wrapped in 「…」)
}

export interface SearchHit {
  rel: string;
  title: string;
  line: number; // first/representative snippet line (back-compat)
  snippet: string; // first/representative snippet text, highlighted (back-compat)
  score: number; // relevance score (F13)
  snippets: Snippet[]; // up to N highlighted snippets (F13)
  project?: string; // source project for cross-project (--across) hits (F15)
  readonly?: boolean; // true when the hit comes from a granted (read-only) scope (F15)
}

/** User-facing error (bad scope, unknown project, invalid type, etc.). */
export class DockyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockyError";
  }
}
