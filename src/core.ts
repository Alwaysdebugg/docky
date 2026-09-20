import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import matter from "gray-matter";
import {
  Config,
  DOC_STATUSES,
  DOC_TYPES,
  DocInfo,
  DocStatus,
  DockyError,
  ProjectContext,
  ScopeDetection,
  SearchHit,
  docTypeWeight,
} from "./types.js";
import {
  configPath,
  defaultConfig,
  isInitialized,
  loadConfig,
  saveConfig,
} from "./config.js";
import { loadTemplate, renderTemplate, staleSeededTemplates } from "./templates.js";
import { fuzzyScore } from "./match.js";

/** Process-local hint for callers that use a bare project name. CLI commands
 * are short-lived and MCP tools pass an explicit branch, so this avoids
 * repeatedly spawning git merely to preserve the core convenience interface. */
const activeBranchHints = new Map<string, string | null>();

function branchHintKey(vault: string, project: string): string {
  return `${path.resolve(vault)}\0${project}`;
}

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
// Vault versioning (F08)
// --------------------------------------------------------------------------- //
function isGitRepo(vault: string): boolean {
  return fs.existsSync(path.join(vault, ".git"));
}

/** Count uncommitted changes in the vault (0 when it isn't a git repo). */
export function uncommittedCount(vault: string): number {
  if (!isGitRepo(vault)) return 0;
  const out = git(vault, ["status", "--porcelain"]);
  return out ? out.split("\n").filter((l) => l.trim()).length : 0;
}

/** Commit all pending vault changes. Returns false if it isn't a repo or there
 *  is nothing to commit. Inline identity keeps it working without global git
 *  config; failures degrade silently (git() already swallows errors). */
export function commitVault(vault: string, message: string): boolean {
  if (!isGitRepo(vault)) return false;
  if (uncommittedCount(vault) === 0) return false;
  git(vault, ["add", "-A"]);
  const res = git(vault, [
    "-c",
    "user.name=docky",
    "-c",
    "user.email=docky@local",
    "commit",
    "-m",
    message,
  ]);
  return res !== null;
}

/** Auto-commit hook invoked by write operations — fires only in "auto" mode. */
export function autoCommitVault(vault: string, message: string): void {
  if (loadConfig(vault).autocommit === "auto") commitVault(vault, message);
}

/** Commit pending changes (manual sync); optionally push to a configured remote. */
export function syncVault(vault: string, push = false): { changes: number; committed: boolean; pushed: boolean } {
  const changes = uncommittedCount(vault);
  const committed = commitVault(vault, "sync: 手动同步");
  let pushed = false;
  if (push && isGitRepo(vault)) pushed = git(vault, ["push"]) !== null;
  return { changes, committed, pushed };
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
  const ignore = path.join(vault, ".gitignore");
  const ignored = [".docky/local.yaml", ".docky/sync-state.json", ".docky/sync.lock"];
  const existingIgnore = fs.existsSync(ignore) ? fs.readFileSync(ignore, "utf-8") : "";
  const missing = ignored.filter((entry) => !existingIgnore.split(/\r?\n/).includes(entry));
  if (missing.length) {
    const prefix = existingIgnore && !existingIgnore.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(ignore, `${existingIgnore}${prefix}${missing.join("\n")}\n`, "utf-8");
  }
  const readme = path.join(vault, "README.md");
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      `# docky-vault\n\nCentralized store for AI-agent-generated Markdown docs, managed by ` +
        `\`docky\` and organized as \`projects/<name>/branches/<branch>/<type>/\`.\n\n` +
        `Types: ${DOC_TYPES.join(", ")}\n\n` +
        `Scaffolding uses each type's built-in template. To override one, drop ` +
        `\`templates/<type>.md\` here — docky never writes that directory itself (F06).\n`,
      "utf-8"
    );
  }
  if (useGit && !fs.existsSync(path.join(vault, ".git"))) {
    git(vault, ["init", "-q"]);
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
  activeBranchHints.set(branchHintKey(vault, best.project), branch);
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
  const branch = gitBranch(p);
  activeBranchHints.set(branchHintKey(vault, name), branch);
  // Registration materializes only the currently checked-out branch. Future
  // branches are created lazily by writeDoc/addDoc/scaffold on first write.
  ensureProjectDirs(vault, scopedProject(vault, name, branch));
}

export function listProjects(vault: string): Config["projects"] {
  return loadConfig(vault).projects;
}

/** Reading-view render preferences (width / theme), from config (F16/F18). */
export function renderPrefs(vault: string): Config["render"] {
  return loadConfig(vault).render;
}

/** Best-guess project name for a directory: git repo name, else dir basename. */
export function inferRepoName(cwd: string): string {
  const root = gitRoot(cwd);
  return path.basename(root ?? path.resolve(cwd));
}

/**
 * Classify how a working directory maps to docky, so callers can offer a
 * one-key fix instead of a dead-end error (F05). Never falls back to a global
 * scope — an unregistered dir stays unregistered, just with a suggested name.
 */
export function detectScope(vault: string, cwd: string): ScopeDetection {
  if (!isInitialized(vault)) return { kind: "no-vault" };
  try {
    return { kind: "registered", project: resolveProject(vault, cwd).project };
  } catch {
    const root = gitRoot(cwd);
    if (root) return { kind: "unregistered-repo", suggestedName: path.basename(root), root };
    return { kind: "no-repo", suggestedName: path.basename(path.resolve(cwd)) };
  }
}

// --------------------------------------------------------------------------- //
// Scope-safe path helpers
// --------------------------------------------------------------------------- //
function projectRootDir(vault: string, project: string): string {
  return path.resolve(vault, "projects", project);
}

/** Resolve a bare registered project to its currently checked-out branch.
 * Explicit scope keys returned by scopedProject pass through unchanged. This
 * keeps the branch decision behind one seam even for core callers/resources
 * that only know a project name. */
function storageScope(vault: string, project: string): string {
  const meta = loadConfig(vault).projects[project];
  if (!meta) return project;
  const key = branchHintKey(vault, project);
  if (activeBranchHints.has(key)) return scopedProject(vault, project, activeBranchHints.get(key));
  const registeredPath = meta.paths?.[0];
  const branch = registeredPath ? gitBranch(expand(registeredPath)) : null;
  activeBranchHints.set(key, branch);
  return scopedProject(vault, project, branch);
}

export function projectDir(vault: string, project: string): string {
  return projectRootDir(vault, storageScope(vault, project));
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
// Branch-scoped isolation (F56). Branches are a permanent part of the layout:
// projects/<name>/branches/<git-branch>/<type>/. `scopedProject` is the single
// seam that owns that mapping; callers never assemble storage paths themselves.
// --------------------------------------------------------------------------- //
/** Branch bucket used when no branch is known (detached HEAD / non-git dir). */
export const DEFAULT_BRANCH_BUCKET = "_unbranched";
export const BRANCHES_DIR = "branches";

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/** Preserve Git's slash hierarchy while making every path segment safe. A
 * changed segment receives a stable hash so distinct refs never collapse to
 * the same directory. */
function safeBranchPathSegment(segment: string): string {
  const cleaned = segment
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (cleaned === segment && cleaned && cleaned !== "." && cleaned !== ".." && cleaned !== DEFAULT_BRANCH_BUCKET) {
    return cleaned;
  }
  return `${cleaned || "_"}-${shortHash(segment)}`;
}

export function branchPath(branch: string | null | undefined): string {
  const value = branch?.trim();
  if (!value) return DEFAULT_BRANCH_BUCKET;
  return value.split("/").map(safeBranchPathSegment).join("/");
}

/** Bucket name used by docky <=0.1, where refs were flattened beside types. */
function legacyBranchSegment(branch: string | null | undefined): string {
  const seg = (branch ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (!seg) return "_default";
  const reserved = new Set<string>([...DOC_TYPES, "_default"]);
  return reserved.has(seg) ? `${seg}-branch` : seg;
}

/**
 * Return the only valid document scope layout. A bare project is never a
 * document bucket; it contains only the `branches/` namespace.
 */
export function scopedProject(_vault: string, project: string, branch?: string | null): string {
  return `${project}/${BRANCHES_DIR}/${branchPath(branch)}`;
}

/** A bare-level entry that holds type subdirs is a branch bucket, not a legacy
 *  type dir — used so migrate never re-buckets an already-migrated branch. */
function looksLikeBranchBucket(dir: string): boolean {
  return DOC_TYPES.some((t) => {
    const p = path.join(dir, t);
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  });
}

export interface MigrateResult {
  scope: string; // "<project>/branches/<branch-path>"
  bucket: string; // branch path docs were moved into
  moved: string[]; // bare-level entries relocated into the bucket
}

/**
 * Move a project's legacy docs (stored directly under projects/<name>/) into a
 * branch bucket projects/<name>/branches/<branch-path>/. Idempotent: occupied
 * destinations are never overwritten.
 */
export function migrateBranchScope(
  vault: string,
  project: string,
  branch: string | null
): MigrateResult {
  const seg = branchPath(branch);
  const base = projectRootDir(vault, project);
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
    throw new DockyError(`项目目录不存在: ${project}`);
  }
  const isMigratable = (entry: string): boolean => {
    if (entry === BRANCHES_DIR) return false;
    const full = path.join(base, entry);
    if ((DOC_TYPES as readonly string[]).includes(entry)) {
      // a legacy type dir holds docs; a branch bucket holds type subdirs. Only
      // relocate type dirs that actually have content (empty ones are tidied below).
      return fs.statSync(full).isDirectory() && !looksLikeBranchBucket(full) && fs.readdirSync(full).length > 0;
    }
    return entry === LEGACY_PARK_DIR || entry === ".trash" || entry === "INDEX.md" || entry.startsWith(".docky-");
  };
  const candidates = fs.readdirSync(base).filter(isMigratable);
  const moved: string[] = [];
  const dest = path.join(base, BRANCHES_DIR, seg);
  const moveEntries = (source: string, entries: string[], label: (entry: string) => string): void => {
    if (entries.length > 0) fs.mkdirSync(dest, { recursive: true });
    for (const entry of entries) {
      const from = path.join(source, entry);
      const to = path.join(dest, entry);
      if (fs.existsSync(to)) {
        const stat = fs.statSync(to);
        if (!stat.isDirectory() || fs.readdirSync(to).length > 0) continue;
        fs.rmdirSync(to);
      }
      fs.renameSync(from, to);
      moved.push(label(entry));
    }
  };

  moveEntries(base, candidates, (entry) => entry);

  // Also upgrade the previous F56 layout (`<project>/<flattened-branch>/`).
  const oldBucketName = legacyBranchSegment(branch);
  const oldBucket = path.join(base, oldBucketName);
  if (oldBucketName !== BRANCHES_DIR && fs.existsSync(oldBucket) && looksLikeBranchBucket(oldBucket)) {
    const oldEntries = fs.readdirSync(oldBucket).filter((entry) => {
      const full = path.join(oldBucket, entry);
      return fs.statSync(full).isDirectory() || entry === "INDEX.md" || entry.startsWith(".docky-");
    });
    moveEntries(oldBucket, oldEntries, (entry) => `${oldBucketName}/${entry}`);
    if (fs.readdirSync(oldBucket).length === 0) fs.rmdirSync(oldBucket);
  }
  // Tidy: drop now-empty legacy type dirs left at the bare level (e.g. the
  // scaffolding ensureProjectDirs pre-creates) so projects/<name>/ holds buckets only.
  for (const t of DOC_TYPES) {
    const p = path.join(base, t);
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory() && fs.readdirSync(p).length === 0) fs.rmdirSync(p);
    } catch {
      /* best-effort cleanup */
    }
  }
  ensureProjectDirs(vault, scopedProject(vault, project, branch));
  if (moved.length) autoCommitVault(vault, `migrate branch-scope: ${project} → ${seg} (${moved.length})`);
  return { scope: scopedProject(vault, project, branch), bucket: seg, moved };
}

// --------------------------------------------------------------------------- //
// Taxonomy migration — relocate docs filed under a retired doc type.
// --------------------------------------------------------------------------- //

/** Directory legacy docs are parked in: inside a project/branch scope but
 *  outside every type dir, so list/search/get_context never surface it. */
export const LEGACY_PARK_DIR = "_legacy";

/**
 * Where each retired type's docs go. `design` merges into `plan` (they became
 * one type). `debug` / `code-review` / `prompts` have no home in the taxonomy,
 * so they are parked under `_legacy/<type>/`: files and git history are kept and
 * still greppable, but docky stops indexing them.
 */
export const LEGACY_TYPE_MOVES: Record<string, string> = {
  design: "plan",
  debug: `${LEGACY_PARK_DIR}/debug`,
  "code-review": `${LEGACY_PARK_DIR}/code-review`,
  prompts: `${LEGACY_PARK_DIR}/prompts`,
};

export interface TypeMove {
  scope: string; // "<project>" or "<project>/<branch-bucket>", relative to projects/
  from: string; // e.g. "design/x.md", relative to the scope dir
  to: string; // e.g. "plan/x.md"
}

export interface TypeMigrationResult {
  applied: boolean; // false for a dry run (nothing touched on disk)
  moves: TypeMove[];
  conflicts: TypeMove[]; // destination already exists → skipped, never overwritten
  pruned: string[]; // emptied legacy type dirs removed, e.g. "<scope>/prompts"
  templates: string[]; // stale docky-seeded templates removed, e.g. "templates/plan.md"
}

/** Every dir name that is a doc bucket rather than a branch bucket. */
function typeDirNames(): Set<string> {
  return new Set<string>([...DOC_TYPES, ...Object.keys(LEGACY_TYPE_MOVES)]);
}

/**
 * Find every directory that can contain document types: the legacy project
 * root, legacy one-level branch buckets, and the current recursively nested
 * branches/<git-ref>/ layout.
 */
function scopeDirsOf(vault: string, project: string): { scope: string; dir: string }[] {
  const base = projectRootDir(vault, project);
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return [];
  const out = [{ scope: project, dir: base }];
  const skip = typeDirNames();

  const collect = (dir: string, scope: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    if (entries.some((e) => e.isDirectory() && skip.has(e.name))) {
      out.push({ scope, dir });
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === LEGACY_PARK_DIR || e.name.startsWith(".")) continue;
      collect(path.join(dir, e.name), `${scope}/${e.name}`);
    }
  };

  for (const e of fs.readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (skip.has(e.name) || e.name === LEGACY_PARK_DIR || e.name.startsWith(".")) continue;
    collect(path.join(base, e.name), `${project}/${e.name}`);
  }
  return out;
}

/**
 * Move documents filed under a retired type into the current taxonomy
 * (LEGACY_TYPE_MOVES), across both the flat and the branch-bucket layout, and
 * drop any template docky itself seeded that the taxonomy has outgrown.
 *
 * Defaults to a DRY RUN: it reports the plan and touches nothing. Pass
 * `apply: true` to perform it. A move whose destination already exists is
 * reported as a conflict and skipped — this never overwrites a document.
 * Idempotent: a second run has nothing left to do.
 */
export function migrateTypes(
  vault: string,
  opts: { project?: string; apply?: boolean } = {}
): TypeMigrationResult {
  const root = path.join(vault, "projects");
  let projects: string[];
  if (opts.project) {
    // This command moves files, so a mistyped project name must not read as
    // "nothing to migrate" — a project docky has never stored a doc for has no
    // directory here, and neither does a typo.
    if (!fs.existsSync(projectRootDir(vault, opts.project))) {
      throw new DockyError(
        `Project '${opts.project}' has no directory in the vault. ` +
          `Run 'docky projects' to see the projects docky knows about.`
      );
    }
    projects = [opts.project];
  } else if (fs.existsSync(root)) {
    projects = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } else {
    projects = [];
  }

  const moves: TypeMove[] = [];
  const conflicts: TypeMove[] = [];
  const pruned: string[] = [];

  for (const project of projects) {
    for (const { scope, dir } of scopeDirsOf(vault, project)) {
      for (const [legacyType, destRel] of Object.entries(LEGACY_TYPE_MOVES)) {
        const src = path.join(dir, legacyType);
        if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) continue;
        const destDir = path.join(dir, destRel);

        // `left` counts what this scan does NOT relocate — a conflict, a
        // non-Markdown file, a nested dir. One tally drives the prune decision
        // in both modes, so a dry run cannot promise a cleanup apply won't do.
        let left = 0;
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
          if (!entry.isFile() || !/\.(md|markdown)$/i.test(entry.name)) {
            left++;
            continue;
          }
          const move: TypeMove = {
            scope,
            from: `${legacyType}/${entry.name}`,
            to: `${destRel}/${entry.name}`,
          };
          if (fs.existsSync(path.join(destDir, entry.name))) {
            conflicts.push(move); // occupied → leave both files alone
            left++;
            continue;
          }
          moves.push(move);
          if (opts.apply) {
            fs.mkdirSync(destDir, { recursive: true });
            fs.renameSync(path.join(src, entry.name), path.join(destDir, entry.name));
          }
        }

        // Drop the legacy dir once it is empty (an untouched conflict keeps it).
        if (left === 0) {
          pruned.push(`${scope}/${legacyType}`);
          if (opts.apply) {
            try {
              fs.rmdirSync(src);
            } catch {
              /* best-effort cleanup */
            }
          }
        }
      }
    }
  }

  // Templates are vault-wide, so this runs once — never per project, and not at
  // all when the caller scoped the migration to one.
  const templates = opts.project ? [] : staleSeededTemplates(vault);
  if (opts.apply) {
    for (const t of templates) fs.rmSync(path.join(vault, "templates", t), { force: true });
  }

  if (opts.apply && (moves.length > 0 || pruned.length > 0 || templates.length > 0)) {
    autoCommitVault(vault, `migrate types: ${moves.length} doc(s) relocated`);
  }
  return { applied: Boolean(opts.apply), moves, conflicts, pruned, templates };
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
  branch: string | null,
  extra: { tags?: string[]; status?: string } = {}
): string {
  const meta: Record<string, unknown> = {
    project,
    type: docType,
    title,
    created: new Date().toISOString().slice(0, 10),
  };
  if (extra.status) meta.status = extra.status;
  if (extra.tags && extra.tags.length) meta.tags = extra.tags;
  if (branch) meta.branch = branch;
  const body = yaml.dump(meta, { sortKeys: false }).trim();
  return `---\n${body}\n---\n`;
}

// --------------------------------------------------------------------------- //
// Document operations
// --------------------------------------------------------------------------- //
interface DocMeta {
  title: string;
  status: DocStatus;
  tags: string[];
}

/** Coerce a frontmatter `status` value to a known lifecycle state. */
function normalizeStatus(v: unknown): DocStatus {
  const s = String(v ?? "").toLowerCase();
  return (DOC_STATUSES as readonly string[]).includes(s) ? (s as DocStatus) : "active";
}

/** Coerce a frontmatter `tags` value (array or comma/space string) to a clean list. */
function normalizeTags(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map((x) => String(x)) : typeof v === "string" ? v.split(/[,\s]+/) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    const clean = t.replace(/^#/, "").trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

/** Read title (frontmatter → first heading → filename) + status + tags in one pass. */
function readDocMeta(filePath: string): DocMeta {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    return { title: path.basename(filePath, ".md"), status: "active", tags: [] };
  }
  const fm = parseFrontmatter(text);
  let title = fm.title ? String(fm.title) : "";
  if (!title) {
    for (const line of text.split("\n")) {
      if (line.startsWith("# ")) {
        title = line.slice(2).trim();
        break;
      }
    }
  }
  if (!title) title = path.basename(filePath, ".md");
  return {
    title,
    status: normalizeStatus(fm.status),
    tags: normalizeTags(fm.tags),
  };
}

function safeMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
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
      const meta = readDocMeta(full);
      const mtime = safeMtimeMs(full);
      out.push({
        project,
        type: t,
        name: f,
        rel: `${t}/${f}`,
        title: meta.title,
        path: full,
        status: meta.status,
        tags: meta.tags,
        mtime,
      });
    }
  }
  return out;
}

export interface DocFilter {
  status?: string;
  tag?: string;
  /** Include archived docs (hidden by default unless status==="archived"). */
  includeArchived?: boolean;
}

/** Apply F03 organization filters. Archived docs are hidden unless explicitly
 *  requested (via includeArchived or status==="archived"). */
export function filterDocs(docs: DocInfo[], f: DocFilter = {}): DocInfo[] {
  const wantStatus = f.status ? f.status.toLowerCase() : undefined;
  const wantTag = f.tag ? f.tag.replace(/^#/, "") : undefined;
  return docs.filter((d) => {
    if (!f.includeArchived && wantStatus !== "archived" && d.status === "archived") return false;
    if (wantStatus && d.status !== wantStatus) return false;
    if (wantTag && !d.tags.includes(wantTag)) return false;
    return true;
  });
}

/** Set a document's lifecycle status by rewriting its frontmatter in place,
 *  preserving the body. Adds frontmatter if the doc had none. */
export function setStatus(
  vault: string,
  project: string,
  rel: string,
  status: string,
  opts: { noCommit?: boolean } = {}
): string {
  const s = status.toLowerCase();
  if (!(DOC_STATUSES as readonly string[]).includes(s)) {
    throw new DockyError(`Invalid status '${status}'. Allowed: ${DOC_STATUSES.join(", ")}`);
  }
  const p = safePath(vault, project, rel);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
    throw new DockyError(`Document not found: ${rel}`);
  }
  const parsed = matter(fs.readFileSync(p, "utf-8"));
  const data = { ...(parsed.data as Record<string, unknown>), status: s };
  fs.writeFileSync(p, matter.stringify(parsed.content, data), "utf-8");
  if (!opts.noCommit) autoCommitVault(vault, `status(${rel}): ${s}`);
  return p;
}

export function addDoc(
  vault: string,
  project: string,
  docType: string,
  src: string,
  opts: {
    branch?: string | null;
    withFrontmatter?: boolean;
    newName?: string;
    noCommit?: boolean;
    tags?: string[];
    status?: string;
    /** Refuse to overwrite an existing target unless force is set. */
    failIfExists?: boolean;
    /** Overwrite an existing target (the previous version stays in git history). */
    force?: boolean;
  } = {}
): string {
  validateType(docType);
  ensureProjectDirs(vault, project);
  src = path.resolve(expand(src));
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    throw new DockyError(`Source file not found: ${src}`);
  }
  let name = opts.newName ?? path.basename(src);
  if (!name.endsWith(".md")) name += ".md";
  const rel = `${docType}/${name}`;
  const dest = safePath(vault, project, rel);
  const exists = fs.existsSync(dest);
  if (exists && opts.failIfExists && !opts.force) {
    throw new DockyError(`${rel} 已存在。--force 覆盖,或换个 --name。`);
  }
  let text = fs.readFileSync(src, "utf-8");
  if (opts.withFrontmatter && Object.keys(parseFrontmatter(text)).length === 0) {
    const title = readDocMeta(src).title;
    text =
      buildFrontmatter(project, docType, title, opts.branch ?? null, {
        tags: opts.tags,
        status: opts.status,
      }) +
      "\n" +
      text;
  }
  fs.writeFileSync(dest, text, "utf-8"); // force overwrite: prior version stays in git history
  if (!opts.noCommit) autoCommitVault(vault, `add(${docType}): ${path.basename(dest)}`);
  return dest;
}

export function writeDoc(vault: string, project: string, docType: string, name: string, content: string): string {
  validateType(docType);
  ensureProjectDirs(vault, project);
  if (!name.endsWith(".md")) name += ".md";
  const dest = safePath(vault, project, `${docType}/${name}`);
  fs.writeFileSync(dest, content, "utf-8");
  autoCommitVault(vault, `write(${docType}): ${path.basename(dest)}`);
  return dest;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Render a type's template (user override → built-in) for a given title (F06). */
export function renderScaffold(vault: string, docType: string, title: string): string {
  validateType(docType);
  return renderTemplate(loadTemplate(vault, docType), { title, date: today() });
}

/**
 * Create a new document from its type template (F06). When `name` is omitted, a
 * date-stamped name is generated. Returns the absolute path of the new file.
 */
export function scaffold(vault: string, project: string, docType: string, name?: string): string {
  validateType(docType);
  const base = (name && name.trim()) || `${docType}-${today()}`;
  const title = base.replace(/\.md$/i, "");
  const content = renderScaffold(vault, docType, title);
  return writeDoc(vault, project, docType, base, content);
}

export function readDoc(vault: string, project: string, rel: string): string {
  const p = safePath(vault, project, rel);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
    throw new DockyError(`Document not found: ${rel}`);
  }
  return fs.readFileSync(p, "utf-8");
}

/** Delete a doc. The removal is auto-committed to the vault, so the file stays
 *  recoverable from git history. */
export function removeDoc(
  vault: string,
  project: string,
  rel: string,
  opts: { noCommit?: boolean } = {}
): void {
  const p = safePath(vault, project, rel);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
    throw new DockyError(`Document not found: ${rel}`);
  }
  fs.unlinkSync(p);
  if (!opts.noCommit) autoCommitVault(vault, `rm: ${rel}`);
}

export function moveDoc(
  vault: string,
  project: string,
  rel: string,
  destType: string,
  newName?: string,
  opts: { force?: boolean; noCommit?: boolean } = {}
): string {
  validateType(destType);
  const src = safePath(vault, project, rel);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    throw new DockyError(`Document not found: ${rel}`);
  }
  let name = newName ?? path.basename(src);
  if (!name.endsWith(".md")) name += ".md";
  const destRel = `${destType}/${name}`;
  const dest = safePath(vault, project, destRel);
  if (fs.existsSync(dest) && !opts.force) {
    throw new DockyError(`${destRel} 已存在。--force 覆盖,或改名。`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest); // force overwrite: prior version stays in git history
  if (!opts.noCommit) autoCommitVault(vault, `mv: ${rel} → ${destType}/${path.basename(dest)}`);
  return dest;
}

const SNIPPET_MAX = 3; // snippets kept per doc
const SCAN_LINES = 2000; // cap per-doc scan for very large files

/** Wrap each case-insensitive occurrence of `q` in the text with 「…」 (F13). */
function highlight(text: string, q: string): string {
  if (!q) return text;
  const lo = text.toLowerCase();
  let out = "";
  let i = 0;
  for (;;) {
    const j = lo.indexOf(q, i);
    if (j < 0) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, j) + "「" + text.slice(j, j + q.length) + "」";
    i = j + q.length;
  }
  return out;
}

/**
 * Search a project's docs (F13): relevance-scored, multi-snippet, with hit
 * highlighting and optional fuzzy matching. Sorted best-first. Title/name hits
 * outweigh body hits; status (F03) feeds the score. Archived docs are excluded
 * by default (via filter). Scope isolation is unchanged.
 */
export function searchDocs(
  vault: string,
  project: string,
  query: string,
  docType?: string,
  filter: DocFilter = {},
  opts: { fuzzy?: boolean; maxSnippets?: number } = {}
): SearchHit[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const maxSnip = opts.maxSnippets ?? SNIPPET_MAX;

  const hits: SearchHit[] = [];
  for (const doc of filterDocs(listDocs(vault, project, docType), filter)) {
    const body = readBody(doc.path);
    const lines = body.split("\n");
    const titleHit = doc.title.toLowerCase().includes(q) || doc.name.toLowerCase().includes(q);

    const snippets: { line: number; text: string }[] = [];
    let bodyHits = 0;
    const scan = Math.min(lines.length, SCAN_LINES);
    for (let i = 0; i < scan; i++) {
      if (lines[i].toLowerCase().includes(q)) {
        bodyHits++;
        if (snippets.length < maxSnip) {
          snippets.push({ line: i + 1, text: highlight(lines[i].trim().slice(0, 200), q) });
        }
      }
    }

    let matched = titleHit || bodyHits > 0;
    let fuzzyOnly = false;
    if (!matched && opts.fuzzy && fuzzyScore(q, `${doc.title} ${doc.name}`) !== null) {
      matched = true;
      fuzzyOnly = true;
    }
    if (!matched) continue;

    let score = 0;
    if (titleHit) score += 8;
    score += Math.min(bodyHits, 5) * 2;
    score += doc.status === "active" ? 3 : doc.status === "draft" ? 1 : 0;
    if (fuzzyOnly) score += 2;

    const first = snippets[0] ?? { line: 0, text: highlight(doc.title, q) };
    hits.push({
      rel: doc.rel,
      title: doc.title,
      line: first.line,
      snippet: first.text,
      score,
      snippets: snippets.length ? snippets : [first],
    });
  }

  hits.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
  return hits;
}

// --------------------------------------------------------------------------- //
// Governed cross-project access (F15) — read-only, explicit, auditable.
// Writes NEVER consult scopes; isolation stays the default.
// --------------------------------------------------------------------------- //
export interface Scope {
  project: string;
  type?: string; // type-scoped grant (e.g. "platform:spec")
  readonly: boolean; // true for granted cross-project scopes
}

function parseGrant(raw: string): { project: string; type?: string } {
  const i = raw.indexOf(":");
  return i < 0 ? { project: raw } : { project: raw.slice(0, i), type: raw.slice(i + 1) };
}

/** The scopes a project may READ: itself (full) + granted projects (read-only,
 *  possibly type-scoped). Unknown/invalid grants are silently dropped (F15). */
export function resolveScopes(vault: string, project: string): Scope[] {
  const cfg = loadConfig(vault);
  const scopes: Scope[] = [{ project, readonly: false }];
  const seen = new Set<string>();
  for (const raw of cfg.grants[project] ?? []) {
    const { project: proj, type } = parseGrant(raw);
    if (proj === project || !(proj in cfg.projects)) continue;
    if (type && !(DOC_TYPES as readonly string[]).includes(type)) continue;
    const key = `${proj}:${type ?? "*"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scopes.push({ project: proj, type, readonly: true });
  }
  return scopes;
}

/** Grant `project` read-only access to `target` ("other" or "other:type"). */
export function addGrant(vault: string, project: string, target: string): void {
  const cfg = loadConfig(vault);
  if (!(project in cfg.projects)) throw new DockyError(`Unknown project: ${project}`);
  const { project: proj, type } = parseGrant(target);
  if (proj === project) throw new DockyError("A project cannot grant access to itself.");
  if (!(proj in cfg.projects)) throw new DockyError(`Unknown grant target project: ${proj}`);
  if (type && !(DOC_TYPES as readonly string[]).includes(type)) {
    throw new DockyError(`Invalid type '${type}'. Allowed: ${DOC_TYPES.join(", ")}`);
  }
  const list = cfg.grants[project] ?? [];
  if (!list.includes(target)) list.push(target);
  cfg.grants[project] = list;
  saveConfig(vault, cfg);
  autoCommitVault(vault, `grant: ${project} → ${target}`);
}

export function revokeGrant(vault: string, project: string, target: string): void {
  const cfg = loadConfig(vault);
  const list = (cfg.grants[project] ?? []).filter((g) => g !== target);
  if (list.length) cfg.grants[project] = list;
  else delete cfg.grants[project];
  saveConfig(vault, cfg);
  autoCommitVault(vault, `revoke: ${project} → ${target}`);
}

export function listGrants(vault: string): Record<string, string[]> {
  return loadConfig(vault).grants;
}

export interface AcrossHit extends SearchHit {
  project: string;
  readonly: boolean;
}

/**
 * Search the project plus every granted (read-only) scope, tagging each hit
 * with its source project. Each per-scope search runs inside that project's own
 * safePath — there is no `../` traversal and writes never use this path (F15).
 */
export function searchAcross(
  vault: string,
  project: string,
  query: string,
  opts: { type?: string; fuzzy?: boolean; branch?: string | null } = {}
): AcrossHit[] {
  const out: AcrossHit[] = [];
  for (const sc of resolveScopes(vault, project)) {
    const type = sc.type ?? opts.type; // type-scoped grants restrict to their type
    if (sc.type && opts.type && sc.type !== opts.type) continue; // grant narrower than request
    let hits: SearchHit[];
    try {
      // Each scope is searched in its own branch bucket (F56); cross-project
      // grants assume the same branch name (missing → no hits, gracefully).
      hits = searchDocs(vault, scopedProject(vault, sc.project, opts.branch), query, type, {}, { fuzzy: opts.fuzzy });
    } catch {
      continue;
    }
    for (const h of hits) out.push({ ...h, project: sc.project, readonly: sc.readonly });
  }
  out.sort(
    (a, b) => b.score - a.score || a.project.localeCompare(b.project) || a.rel.localeCompare(b.rel)
  );
  return out;
}

// --------------------------------------------------------------------------- //
// Smart write: dedupe / append / merge for agent writes (F20)
// --------------------------------------------------------------------------- //
/** Character-bigram set, used for a tokenizer-free similarity (CJK + ASCII). */
function bigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/\s+/g, "");
  const set = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) set.add(t.slice(i, i + 2));
  return set;
}

/** Jaccard similarity of two strings' character bigrams (0–1). */
export function textSimilarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return a === b ? 1 : 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function titleFromContent(content: string): string {
  const fm = parseFrontmatter(content);
  if (fm.title) return String(fm.title);
  for (const line of content.split("\n")) if (line.startsWith("# ")) return line.slice(2).trim();
  return "";
}

export interface SimilarDoc {
  rel: string;
  similarity: number;
}

/** Find existing docs similar to a proposed one (name/title/body), best first.
 *  Reuses no LLM — bigram similarity over name, title, and a body prefix (F20). */
export function findSimilar(
  vault: string,
  project: string,
  doc: { name: string; title?: string; content?: string },
  opts: { threshold?: number; limit?: number } = {}
): SimilarDoc[] {
  const threshold = opts.threshold ?? 0.3;
  const propName = doc.name.replace(/\.md$/i, "");
  const propTitle = doc.title || titleFromContent(doc.content || "");
  const propBody = (doc.content || "").slice(0, 800);
  const out: SimilarDoc[] = [];
  for (const d of listDocs(vault, project)) {
    const nameSim = textSimilarity(propName, d.name.replace(/\.md$/i, ""));
    const titleSim = textSimilarity(propTitle, d.title);
    const bodySim = textSimilarity(propBody, readBody(d.path).slice(0, 800));
    const sim = 0.35 * nameSim + 0.35 * titleSim + 0.3 * bodySim;
    if (sim >= threshold) out.push({ rel: d.rel, similarity: Math.round(sim * 100) / 100 });
  }
  return out.sort((a, b) => b.similarity - a.similarity).slice(0, opts.limit ?? 5);
}

/** Append content as a timestamped section to an existing doc (F20). */
export function appendDoc(vault: string, project: string, rel: string, content: string): string {
  const p = safePath(vault, project, rel);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
    throw new DockyError(`Document not found: ${rel}`);
  }
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const existing = fs.readFileSync(p, "utf-8").replace(/\s*$/, "");
  fs.writeFileSync(p, `${existing}\n\n## 追加 ${stamp}\n\n${content}\n`, "utf-8");
  autoCommitVault(vault, `append: ${rel}`);
  return p;
}

/** A human/agent-readable merge preview keeping both sides (no auto-merge, F20). */
export function mergePreview(vault: string, project: string, rel: string, content: string): string {
  const existing = readDoc(vault, project, rel);
  return `<<<<<<< 现有 ${rel}\n${existing}\n=======\n${content}\n>>>>>>> 新内容`;
}

export type WriteMode = "new" | "append" | "merge" | "replace";

export type WriteOutcome =
  | { status: "written"; rel: string }
  | { status: "appended"; rel: string }
  | { status: "duplicate_suspected"; candidate: SimilarDoc; suggestion: string; hint: string }
  | { status: "merge_preview"; rel: string; preview: string; hint: string };

/** YYYY-MM-DD-HHmm timestamp (UTC, consistent with today() and append stamps). */
function dateTimeStamp(): string {
  const iso = new Date().toISOString(); // 2026-06-23T14:30:45.123Z
  return `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`; // 2026-06-23-1430
}

/** Leading ISO-date prefix (date, optionally with -HHmm), used to detect an
 *  already-dated doc name so date-stamping stays idempotent. */
const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}(-\d{4})?-/;

/**
 * Prepend a YYYY-MM-DD-HHmm stamp to an agent-generated doc name so the vault
 * stays chronologically sortable. Idempotent: a name that already leads with an
 * ISO date is returned unchanged. Operates on the bare name (.md is handled by
 * writeDoc downstream).
 */
export function datePrefixed(name: string): string {
  return DATE_PREFIX_RE.test(name) ? name : `${dateTimeStamp()}-${name}`;
}

/**
 * Agent-safe write (F20): in the default "new" mode, refuses to silently
 * overwrite/duplicate — if the target name exists or a near-duplicate is found,
 * returns a structured suggestion instead of writing. append/merge/replace are
 * explicit. Human-side add/write are unaffected.
 *
 * Every brand-new doc an agent generates is date-stamped (datePrefixed): the
 * created file name leads with a YYYY-MM-DD-HHmm prefix. Operations that target
 * an existing doc by name (append/replace/merge onto a match) keep its name.
 */
export function smartWrite(
  vault: string,
  project: string,
  docType: string,
  name: string,
  content: string,
  mode: WriteMode = "new"
): WriteOutcome {
  validateType(docType);
  const fileName = name.endsWith(".md") ? name : `${name}.md`;
  const rel = `${docType}/${fileName}`;
  const exists = docFileExists(vault, project, rel);

  // Create a fresh, date-stamped file — used by every path that generates a new
  // doc rather than targeting an existing one by name.
  const createNew = (): WriteOutcome => {
    const dest = writeDoc(vault, project, docType, datePrefixed(name), content);
    return { status: "written", rel: `${docType}/${path.basename(dest)}` };
  };

  if (mode === "append") {
    if (exists) {
      appendDoc(vault, project, rel, content);
      return { status: "appended", rel };
    }
    return createNew();
  }
  if (mode === "replace") {
    if (exists) {
      writeDoc(vault, project, docType, name, content); // overwrite keeps the existing name (prior version in git)
      return { status: "written", rel };
    }
    return createNew();
  }
  if (mode === "merge") {
    const target = exists ? rel : findSimilar(vault, project, { name: fileName, content })[0]?.rel;
    if (!target) return createNew();
    return {
      status: "merge_preview",
      rel: target,
      preview: mergePreview(vault, project, target, content),
      hint: "确认后用 mode=replace 写入合并结果,或 mode=append 追加",
    };
  }

  // mode "new": detect a same-name or near-duplicate conflict; never silent.
  const similar = findSimilar(vault, project, { name: fileName, content });
  const candidate: SimilarDoc | null = exists
    ? { rel, similarity: 1 }
    : similar.find((s) => s.rel !== rel) ?? null;
  if (candidate) {
    return {
      status: "duplicate_suspected",
      candidate,
      suggestion: exists ? "replace" : "append",
      hint: "再次调用并指定 mode=append|merge|replace 以继续",
    };
  }
  return createNew();
}

// --------------------------------------------------------------------------- //
// Doc existence check (scope-checked) — used by smart write (F20)
// --------------------------------------------------------------------------- //
function docFileExists(vault: string, project: string, rel: string): boolean {
  try {
    const abs = safePath(vault, project, rel);
    return fs.existsSync(abs) && fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------- //
// Agent context bundle (F07)
// --------------------------------------------------------------------------- //
export interface ContextItem {
  rel: string;
  type: string;
  status: DocStatus;
  title: string;
  tags: string[];
  score: number;
  excerpt: string;
  project?: string; // set for cross-project (granted, read-only) items (F15)
}

export interface ContextBundle {
  project: string;
  items: ContextItem[];
  truncatedBy: "budget" | "count" | null;
  note: string | null;
}

/** Rough token estimate (avoids a tokenizer dep): ~4 chars/token. */
function estTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** First meaningful content line (skips frontmatter + headings), truncated. */
function firstParagraph(body: string): string {
  let text = body;
  const fm = text.match(/^---\n[\s\S]*?\n---\n?/);
  if (fm) text = text.slice(fm[0].length);
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    return line.length > 160 ? line.slice(0, 157) + "…" : line;
  }
  return "";
}

/**
 * Build a ranked, budget-bounded bundle of the project's most relevant docs for
 * an agent (F07). Composes F01 (relevance) and F03 (status, archived excluded).
 * Never leaves the project scope.
 */
export function buildContext(
  vault: string,
  project: string,
  opts: { query?: string; budget?: number; across?: boolean; branch?: string | null } = {}
): ContextBundle {
  const query = (opts.query ?? "").trim();
  const scope = scopedProject(vault, project, opts.branch); // F56: branch bucket (else bare)
  const all = listDocs(vault, scope);
  const archivedCount = all.filter((d) => d.status === "archived").length;
  const docs = filterDocs(all); // hide archived

  const terms = query ? query.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const snippetByRel = new Map<string, string>();
  if (query) {
    for (const h of searchDocs(vault, scope, query)) {
      if (!snippetByRel.has(h.rel)) snippetByRel.set(h.rel, h.snippet);
    }
  }

  function relevance(d: DocInfo, body: string): number {
    if (!terms.length) return 0;
    const title = d.title.toLowerCase();
    const name = d.name.toLowerCase();
    const tags = d.tags.join(" ").toLowerCase();
    const low = body.toLowerCase();
    let s = 0;
    for (const t of terms) {
      if (title.includes(t)) s += 6;
      if (name.includes(t)) s += 3;
      if (tags.includes(t)) s += 4;
      let idx = low.indexOf(t);
      let n = 0;
      while (idx >= 0 && n < 5) {
        n++;
        idx = low.indexOf(t, idx + t.length);
      }
      s += n;
    }
    return s;
  }

  function metaScore(d: DocInfo): number {
    const s = d.status === "active" ? 3 : d.status === "draft" ? 1 : 0;
    // Durable, authoritative types (constitution / spec / adr) outrank throwaway
    // ones (tasks); the weight is derived from the type's review level (types.ts).
    return s + docTypeWeight(d.type);
  }

  const scored = docs.map((d) => {
    let body = "";
    try {
      body = fs.readFileSync(d.path, "utf-8");
    } catch {
      /* unreadable → empty body */
    }
    const rel = relevance(d, body);
    const excerpt = snippetByRel.get(d.rel) || firstParagraph(body) || d.title;
    return { d, rel, score: rel + metaScore(d), excerpt };
  });

  const noteParts: string[] = [];
  let candidates = scored;
  if (query) {
    const matched = scored.filter((s) => s.rel > 0);
    if (matched.length) {
      candidates = matched;
    } else {
      noteParts.push(`无 '${query}' 命中,返回项目概览`);
    }
  }
  candidates = [...candidates].sort((a, b) => b.score - a.score || a.d.rel.localeCompare(b.d.rel));

  const toItem = (s: (typeof scored)[number]): ContextItem => ({
    rel: s.d.rel,
    type: s.d.type,
    status: s.d.status,
    title: s.d.title,
    tags: s.d.tags,
    score: s.score,
    excerpt: s.excerpt,
  });

  const MAX_ITEMS = 8;
  const items: ContextItem[] = [];
  let truncatedBy: "budget" | "count" | null = null;

  if (typeof opts.budget === "number" && opts.budget > 0) {
    let used = 0;
    for (const s of candidates) {
      const item = toItem(s);
      const cost = estTokens(`${item.title} ${item.rel} ${item.excerpt}`) + 8;
      if (items.length > 0 && used + cost > opts.budget) {
        truncatedBy = "budget";
        break;
      }
      items.push(item);
      used += cost;
    }
  } else {
    for (const s of candidates.slice(0, MAX_ITEMS)) items.push(toItem(s));
    if (candidates.length > MAX_ITEMS) truncatedBy = "count";
  }

  // Cross-project (granted, read-only) aggregation — only when explicitly asked
  // and a query is given. Each granted scope is searched in its own scope (F15).
  if (opts.across && query) {
    let crossCount = 0;
    for (const sc of resolveScopes(vault, project).filter((s) => s.readonly)) {
      for (const h of searchDocs(vault, scopedProject(vault, sc.project, opts.branch), query, sc.type, {}, {}).slice(0, 3)) {
        const slash = h.rel.indexOf("/");
        items.push({
          rel: h.rel,
          type: slash >= 0 ? h.rel.slice(0, slash) : h.rel,
          status: "active",
          title: h.title,
          tags: [],
          score: h.score,
          excerpt: h.snippet,
          project: sc.project,
        });
        crossCount++;
      }
    }
    if (crossCount) noteParts.push(`含 ${crossCount} 篇跨项目(只读)`);
  }

  if (archivedCount > 0) noteParts.unshift(`已排除 ${archivedCount} 篇 archived`);
  return { project, items, truncatedBy, note: noteParts.length ? noteParts.join(";") : null };
}

// --------------------------------------------------------------------------- //
// Body reader — shared by search / similarity / context
// --------------------------------------------------------------------------- //
function readBody(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

// re-export for convenience
export { configPath, isInitialized };
