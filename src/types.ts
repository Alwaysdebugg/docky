export const DOC_TYPES = ["design", "plan", "debug", "code-review", "prompts"] as const;
export type DocType = (typeof DOC_TYPES)[number];

export interface ProjectMeta {
  paths: string[];
  link: boolean;
}

export interface Config {
  version: number;
  types: string[];
  projects: Record<string, ProjectMeta>;
}

export interface ProjectContext {
  project: string;
  branch: string | null;
  root: string | null;
}

export interface DocInfo {
  project: string;
  type: string;
  name: string;
  rel: string; // relative to project dir, e.g. "design/foo.md"
  title: string;
  path: string;
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
