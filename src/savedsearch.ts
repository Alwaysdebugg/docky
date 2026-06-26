/**
 * Saved searches / smart folders (F24): persist named queries per project and
 * evaluate them LIVE (they store a query, not a result snapshot). Queries reuse
 * F03 filters (type / --status / #tag / --stale) and F13 keyword search — no new
 * syntax. Stored in projects/<p>/.docky-folders.json (scope-safe, gitignored).
 */
import fs from "node:fs";
import * as core from "./core.js";
import { DOC_TYPES, DocInfo, DockyError } from "./types.js";

const FOLDERS_FILE = ".docky-folders.json";

function load(vault: string, project: string): Record<string, string> {
  try {
    const data = JSON.parse(fs.readFileSync(core.safePath(vault, project, FOLDERS_FILE), "utf-8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function persist(vault: string, project: string, folders: Record<string, string>): void {
  fs.writeFileSync(core.safePath(vault, project, FOLDERS_FILE), JSON.stringify(folders, null, 2), "utf-8");
}

export function saveFolder(vault: string, project: string, name: string, query: string): void {
  if (!name.trim()) throw new DockyError("文件夹名不能为空");
  if (!query.trim()) throw new DockyError("查询不能为空");
  parseQuery(query); // validate (never throws today, but keeps a hook)
  const folders = load(vault, project);
  folders[name] = query.trim();
  persist(vault, project, folders);
}

export function removeFolder(vault: string, project: string, name: string): void {
  const folders = load(vault, project);
  if (!(name in folders)) throw new DockyError(`没有名为「${name}」的智能文件夹`);
  delete folders[name];
  persist(vault, project, folders);
}

export function getFolder(vault: string, project: string, name: string): string | null {
  return load(vault, project)[name] ?? null;
}

export function listFolders(vault: string, project: string): { name: string; query: string }[] {
  return Object.entries(load(vault, project)).map(([name, query]) => ({ name, query }));
}

export interface ParsedQuery {
  type?: string;
  status?: string;
  tag?: string;
  stale: boolean;
  keywords: string;
}

/** Parse a saved query into F03 filters + leftover keyword search (F13). */
export function parseQuery(query: string): ParsedQuery {
  const tokens = query.split(/\s+/).filter(Boolean);
  const p: ParsedQuery = { stale: false, keywords: "" };
  const kw: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--stale") p.stale = true;
    else if (t === "--status" || t === "-s") {
      const s = tokens[++i];
      if (s) p.status = s.toLowerCase();
    } else if (t.startsWith("#") && t.length > 1) p.tag = t.slice(1);
    else if (!p.type && (DOC_TYPES as readonly string[]).includes(t)) p.type = t;
    else kw.push(t);
  }
  p.keywords = kw.join(" ");
  return p;
}

/** Evaluate a folder's query against the current library (live). */
export function evalFolder(vault: string, project: string, query: string): DocInfo[] {
  const q = parseQuery(query);
  const filter = { status: q.status, tag: q.tag, stale: q.stale };
  if (q.keywords) {
    const byRel = new Map(core.listDocs(vault, project).map((d) => [d.rel, d]));
    return core
      .searchDocs(vault, project, q.keywords, q.type, filter)
      .map((h) => byRel.get(h.rel))
      .filter((d): d is DocInfo => Boolean(d));
  }
  return core.filterDocs(core.listDocs(vault, project, q.type), filter);
}
