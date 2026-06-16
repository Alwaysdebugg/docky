import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import matter from "gray-matter";
import {
  Config,
  DOC_TYPES,
  DocInfo,
  DockyError,
  ProjectContext,
  SearchHit,
} from "./types.js";
import {
  configPath,
  defaultConfig,
  isInitialized,
  loadConfig,
  saveConfig,
} from "./config.js";

// --------------------------------------------------------------------------- //
// Git helpers
// --------------------------------------------------------------------------- //
function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function gitRoot(cwd: string): string | null {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  return root ? path.resolve(root) : null;
}

export function gitBranch(cwd: string): string | null {
  const b = git(cwd, ["branch", "--show-current"]);
  if (b) return b;
  const b2 = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return b2 && b2 !== "HEAD" ? b2 : null;
}

// --------------------------------------------------------------------------- //
// Path helpers
// --------------------------------------------------------------------------- //
/** True if `child` is `parent` or lives inside it. */
function pathContains(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// --------------------------------------------------------------------------- //
// Vault initialization
// --------------------------------------------------------------------------- //
export function initVault(vault: string, useGit = true): string {
  vault = path.resolve(vault);
  fs.mkdirSync(path.join(vault, "projects"), { recursive: true });
  if (!isInitialized(vault)) saveConfig(vault, defaultConfig());
  const readme = path.join(vault, "README.md");
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      `# docky-vault\n\nCentralized store for AI-agent-generated Markdown docs, managed by ` +
        `\`docky\` and organized as \`projects/<name>/<type>/\`.\n\nTypes: ${DOC_TYPES.join(", ")}\n`,
      "utf-8"
    );
  }
  if (useGit && !fs.existsSync(path.join(vault, ".git"))) {
    git(vault, ["init", "-q"]);
    fs.writeFileSync(path.join(vault, ".gitignore"), "", "utf-8");
  }
  return vault;
}

// --------------------------------------------------------------------------- //
// Project resolution & registration
// --------------------------------------------------------------------------- //
export function resolveProject(vault: string, cwd: string): ProjectContext {
  cwd = path.resolve(cwd);
  const cfg = loadConfig(vault);
  const projects = cfg.projects;
  if (Object.keys(projects).length === 0) {
    throw new DockyError("No projects registered yet. Run `docky register <name>` first.");
  }

  const root = gitRoot(cwd);
  const branch = root ? gitBranch(cwd) : null;
  const candidates = [root, cwd].filter((c): c is string => c !== null);

  // Prefer the most specific (longest) registered path matching a candidate.
  let best: { len: number; project: string; matched: string } | null = null;
  for (const [name, meta] of Object.entries(projects)) {
    for (const raw of meta.paths ?? []) {
      const reg = path.resolve(expand(raw));
      for (const cand of candidates) {
        if (pathContains(reg, cand) || pathContains(cand, reg)) {
          const len = reg.length;
          if (best === null || len > best.len) best = { len, project: name, matched: reg };
        }
      }
    }
  }

  if (best === null) {
    throw new DockyError(
      `Working directory '${cwd}' is not registered to any project.\n` +
        `Run \`docky register <name>\` here, or pass --project explicitly.`
    );
  }
  return { project: best.project, branch, root: best.matched };
}

function expand(p: string): string {
  return p.startsWith("~") ? path.join(process.env.HOME || "", p.slice(1)) : p;
}

export function registerProject(vault: string, name: string, localPath: string, link = false): void {
  const cfg = loadConfig(vault);
  const entry = cfg.projects[name] ?? { paths: [], link };
  const p = path.resolve(expand(localPath));
  if (!entry.paths.includes(p)) entry.paths.push(p);
  entry.link = Boolean(entry.link || link);
  cfg.projects[name] = entry;
  saveConfig(vault, cfg);
  ensureProjectDirs(vault, name);
}

export function listProjects(vault: string): Config["projects"] {
  return loadConfig(vault).projects;
}

// --------------------------------------------------------------------------- //
// Scope-safe path helpers
// --------------------------------------------------------------------------- //
export function projectDir(vault: string, project: string): string {
  return path.resolve(vault, "projects", project);
}

export function validateType(docType: string): string {
  if (!(DOC_TYPES as readonly string[]).includes(docType)) {
    throw new DockyError(`Invalid type '${docType}'. Allowed: ${DOC_TYPES.join(", ")}`);
  }
  return docType;
}

/**
 * Resolve a relative doc path, guaranteeing it stays inside the project.
 * This is the hard scope-isolation boundary: any path escaping the project
 * directory (e.g. '../other-project/x.md') is rejected.
 */
export function safePath(vault: string, project: string, rel: string): string {
  const base = projectDir(vault, project);
  const target = path.resolve(base, rel);
  if (target !== base && !pathContains(base, target)) {
    throw new DockyError(`Path '${rel}' escapes project scope '${project}'. Refused.`);
  }
  return target;
}

export function ensureProjectDirs(vault: string, project: string): void {
  const base = projectDir(vault, project);
  fs.mkdirSync(base, { recursive: true });
  for (const t of DOC_TYPES) fs.mkdirSync(path.join(base, t), { recursive: true });
}

// --------------------------------------------------------------------------- //
// Frontmatter
// --------------------------------------------------------------------------- //
export function parseFrontmatter(text: string): Record<string, unknown> {
  try {
    const parsed = matter(text);
    return (parsed.data as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

export function buildFrontmatter(
  project: string,
  docType: string,
  title: string,
  branch: string | null
): string {
  const meta: Record<string, unknown> = {
    project,
    type: docType,
    title,
    created: new Date().toISOString().slice(0, 10),
  };
  if (branch) meta.branch = branch;
  const body = yaml.dump(meta, { sortKeys: false }).trim();
  return `---\n${body}\n---\n`;
}

// --------------------------------------------------------------------------- //
// Document operations
// --------------------------------------------------------------------------- //
function titleOf(filePath: string): string {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    return path.basename(filePath, ".md");
  }
  const fm = parseFrontmatter(text);
  if (fm.title) return String(fm.title);
  for (const line of text.split("\n")) {
    if (line.startsWith("# ")) return line.slice(2).trim();
  }
  return path.basename(filePath, ".md");
}

export function listDocs(vault: string, project: string, docType?: string): DocInfo[] {
  const types = docType ? [validateType(docType)] : [...DOC_TYPES];
  const out: DocInfo[] = [];
  const base = projectDir(vault, project);
  for (const t of types) {
    const d = path.join(base, t);
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) continue;
    const files = fs.readdirSync(d).filter((f) => f.endsWith(".md")).sort();
    for (const f of files) {
      const full = path.join(d, f);
      out.push({ project, type: t, name: f, rel: `${t}/${f}`, title: titleOf(full), path: full });
    }
  }
  return out;
}

export function addDoc(
  vault: string,
  project: string,
  docType: string,
  src: string,
  opts: { branch?: string | null; withFrontmatter?: boolean; newName?: string } = {}
): string {
  validateType(docType);
  ensureProjectDirs(vault, project);
  src = path.resolve(expand(src));
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    throw new DockyError(`Source file not found: ${src}`);
  }
  let name = opts.newName ?? path.basename(src);
  if (!name.endsWith(".md")) name += ".md";
  const dest = safePath(vault, project, `${docType}/${name}`);
  let text = fs.readFileSync(src, "utf-8");
  if (opts.withFrontmatter && Object.keys(parseFrontmatter(text)).length === 0) {
    const title = titleOf(src);
    text = buildFrontmatter(project, docType, title, opts.branch ?? null) + "\n" + text;
  }
  fs.writeFileSync(dest, text, "utf-8");
  return dest;
}

export function writeDoc(vault: string, project: string, docType: string, name: string, content: string): string {
  validateType(docType);
  ensureProjectDirs(vault, project);
  if (!name.endsWith(".md")) name += ".md";
  const dest = safePath(vault, project, `${docType}/${name}`);
  fs.writeFileSync(dest, content, "utf-8");
  return dest;
}

export function readDoc(vault: string, project: string, rel: string): string {
  const p = safePath(vault, project, rel);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
    throw new DockyError(`Document not found: ${rel}`);
  }
  return fs.readFileSync(p, "utf-8");
}

export function removeDoc(vault: string, project: string, rel: string): void {
  const p = safePath(vault, project, rel);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
    throw new DockyError(`Document not found: ${rel}`);
  }
  fs.unlinkSync(p);
}

export function moveDoc(
  vault: string,
  project: string,
  rel: string,
  destType: string,
  newName?: string
): string {
  validateType(destType);
  const src = safePath(vault, project, rel);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    throw new DockyError(`Document not found: ${rel}`);
  }
  let name = newName ?? path.basename(src);
  if (!name.endsWith(".md")) name += ".md";
  const dest = safePath(vault, project, `${destType}/${name}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  return dest;
}

export function searchDocs(vault: string, project: string, query: string, docType?: string): SearchHit[] {
  const q = query.toLowerCase();
  const hits: SearchHit[] = [];
  for (const doc of listDocs(vault, project, docType)) {
    let lines: string[];
    try {
      lines = fs.readFileSync(doc.path, "utf-8").split("\n");
    } catch {
      continue;
    }
    if (doc.name.toLowerCase().includes(q) || doc.title.toLowerCase().includes(q)) {
      hits.push({ rel: doc.rel, title: doc.title, line: 0, snippet: doc.title });
    }
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(q)) {
        hits.push({ rel: doc.rel, title: doc.title, line: i + 1, snippet: lines[i].trim().slice(0, 200) });
        break; // one snippet per doc keeps results compact
      }
    }
  }
  return hits;
}

// --------------------------------------------------------------------------- //
// INDEX generation
// --------------------------------------------------------------------------- //
export function generateIndex(vault: string, project: string): string {
  const docs = listDocs(vault, project);
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const lines = [`# ${project} — 文档索引`, "", `_自动生成于 ${stamp}_`, ""];
  if (docs.length === 0) lines.push("_(暂无文档)_");
  for (const t of DOC_TYPES) {
    const group = docs.filter((d) => d.type === t);
    if (group.length === 0) continue;
    lines.push(`## ${t}`, "");
    for (const d of group) lines.push(`- [${d.title}](${d.rel})`);
    lines.push("");
  }
  const base = projectDir(vault, project);
  fs.mkdirSync(base, { recursive: true });
  const index = path.join(base, "INDEX.md");
  fs.writeFileSync(index, lines.join("\n"), "utf-8");
  return index;
}

// --------------------------------------------------------------------------- //
// Symlink + .gitignore maintenance (optional convenience)
// --------------------------------------------------------------------------- //
export function linkProject(vault: string, project: string, linkName = "docs"): string {
  const cfg = loadConfig(vault);
  const meta = cfg.projects[project];
  if (!meta) throw new DockyError(`Unknown project: ${project}`);
  const target = projectDir(vault, project);
  const created: string[] = [];
  for (const raw of meta.paths ?? []) {
    const local = path.resolve(expand(raw));
    if (!fs.existsSync(local) || !fs.statSync(local).isDirectory()) continue;
    const link = path.join(local, linkName);
    if (fs.existsSync(link) || isSymlink(link)) fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(target, link, "dir");
    ensureGitignore(local, linkName);
    created.push(link);
  }
  meta.link = true;
  saveConfig(vault, cfg);
  if (created.length === 0) throw new DockyError(`No valid local path found for project '${project}'.`);
  return created[0];
}

export function unlinkProject(vault: string, project: string, linkName = "docs"): void {
  const cfg = loadConfig(vault);
  const meta = cfg.projects[project];
  if (!meta) throw new DockyError(`Unknown project: ${project}`);
  for (const raw of meta.paths ?? []) {
    const local = path.resolve(expand(raw));
    const link = path.join(local, linkName);
    if (isSymlink(link)) fs.unlinkSync(link);
  }
  meta.link = false;
  saveConfig(vault, cfg);
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function ensureGitignore(repo: string, entry: string): void {
  const gi = path.join(repo, ".gitignore");
  const line = `/${entry}`;
  const existing = fs.existsSync(gi) ? fs.readFileSync(gi, "utf-8").split("\n") : [];
  if (existing.includes(line) || existing.includes(entry)) return;
  const prefix = existing.length && existing[existing.length - 1].trim() ? "\n" : "";
  fs.appendFileSync(gi, `${prefix}# docky-managed docs symlink\n${line}\n`, "utf-8");
}

// re-export for convenience
export { configPath, isInitialized };
