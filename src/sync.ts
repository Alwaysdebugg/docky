import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig } from "./config.js";
import { DockyError } from "./types.js";

const REMOTE_NAME = "docky-cloud";
const DEFAULT_REMOTE_BRANCH = "main";
const LOCK_STALE_MS = 5 * 60 * 1000;

export type SyncState = "off" | "idle" | "pending" | "syncing" | "conflict" | "error";
export type SyncTrigger = "manual" | "automatic";

export interface SyncStatus {
  enabled: boolean;
  connected: boolean;
  remote?: string;
  branch: string;
  state: SyncState;
  pendingChanges: number;
  ahead: number;
  behind: number;
  lastSyncedAt?: string;
  lastError?: string;
  conflicts: string[];
}

export interface SyncResult {
  status: SyncStatus;
  committed: boolean;
  pulled: number;
  pushed: boolean;
}

export interface SyncOptions {
  enabled?: boolean;
  remote?: string;
  branch?: string;
}

interface PersistedState {
  state: SyncState;
  lastSyncedAt?: string;
  lastError?: string;
  conflicts?: string[];
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function gitDir(vault: string): string {
  return path.join(vault, ".git");
}

function ensureRepo(vault: string): void {
  if (!fs.existsSync(gitDir(vault))) {
    throw new DockyError(`Cloud sync requires a Git-backed vault: ${vault}`);
  }
}

function runGit(
  vault: string,
  args: string[],
  opts: { allowFailure?: boolean; timeoutMs?: number } = {}
): GitResult {
  const result = spawnSync("git", args, {
    cwd: vault,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeoutMs ?? 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? result.error?.message ?? "").trim();
  const ok = result.status === 0;
  if (!ok && !opts.allowFailure) {
    throw new DockyError(stderr || `git ${args[0]} failed${result.status === null ? " (timed out)" : ""}`);
  }
  return { ok, stdout, stderr };
}

function gitConfig(vault: string, key: string): string | undefined {
  const result = runGit(vault, ["config", "--local", "--get", key], { allowFailure: true });
  return result.ok && result.stdout ? result.stdout : undefined;
}

function setGitConfig(vault: string, key: string, value: string): void {
  runGit(vault, ["config", "--local", key, value]);
}

function statePath(vault: string): string {
  return path.join(vault, ".docky", "sync-state.json");
}

function lockPath(vault: string): string {
  return path.join(vault, ".docky", "sync.lock");
}

function readState(vault: string): PersistedState {
  const file = statePath(vault);
  if (!fs.existsSync(file)) return { state: "idle" };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<PersistedState>;
    return {
      state: ["off", "idle", "pending", "syncing", "conflict", "error"].includes(parsed.state ?? "")
        ? (parsed.state as SyncState)
        : "idle",
      lastSyncedAt: parsed.lastSyncedAt,
      lastError: parsed.lastError,
      conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts.map(String) : [],
    };
  } catch {
    return { state: "error", lastError: "Invalid local sync state." };
  }
}

function writeState(vault: string, state: PersistedState): void {
  const file = statePath(vault);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function ensureIgnored(vault: string): void {
  const file = path.join(vault, ".gitignore");
  const wanted = [".docky/local.yaml", ".docky/sync-state.json", ".docky/sync.lock"];
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  const lines = current.split(/\r?\n/);
  const missing = wanted.filter((entry) => !lines.includes(entry));
  if (!missing.length) return;
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(file, `${current}${prefix}${missing.join("\n")}\n`, "utf-8");
}

function pendingChanges(vault: string): number {
  const out = runGit(vault, ["status", "--porcelain"], { allowFailure: true }).stdout;
  return out ? out.split("\n").filter(Boolean).length : 0;
}

function hasHead(vault: string): boolean {
  return runGit(vault, ["rev-parse", "--verify", "HEAD"], { allowFailure: true }).ok;
}

function remoteRef(branch: string): string {
  return `refs/remotes/${REMOTE_NAME}/${branch}`;
}

function refExists(vault: string, ref: string): boolean {
  return runGit(vault, ["show-ref", "--verify", "--quiet", ref], { allowFailure: true }).ok;
}

function aheadBehind(vault: string, branch: string): { ahead: number; behind: number } {
  if (!hasHead(vault) || !refExists(vault, remoteRef(branch))) return { ahead: 0, behind: 0 };
  const result = runGit(vault, ["rev-list", "--left-right", "--count", `HEAD...${remoteRef(branch)}`], {
    allowFailure: true,
  });
  if (!result.ok) return { ahead: 0, behind: 0 };
  const [ahead, behind] = result.stdout.split(/\s+/).map(Number);
  return { ahead: Number.isFinite(ahead) ? ahead : 0, behind: Number.isFinite(behind) ? behind : 0 };
}

function acquireLock(vault: string): number {
  const file = lockPath(vault);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age > LOCK_STALE_MS) fs.unlinkSync(file);
  }
  try {
    const fd = fs.openSync(file, "wx");
    fs.writeFileSync(fd, `${process.pid}\n`, "utf-8");
    return fd;
  } catch {
    throw new DockyError("Another Docky sync is already running for this workspace.");
  }
}

function releaseLock(vault: string, fd: number): void {
  try {
    fs.closeSync(fd);
  } finally {
    try {
      fs.unlinkSync(lockPath(vault));
    } catch {
      // Best effort; stale locks are reclaimed on the next attempt.
    }
  }
}

function commitPending(vault: string): boolean {
  if (pendingChanges(vault) === 0 && hasHead(vault)) return false;
  runGit(vault, ["add", "-A"]);
  const result = runGit(
    vault,
    [
      "-c",
      "user.name=docky",
      "-c",
      "user.email=docky@local",
      "commit",
      "-m",
      "sync: cloud snapshot",
    ],
    { allowFailure: true }
  );
  if (!result.ok && !hasHead(vault)) throw new DockyError(result.stderr || "Could not create the initial sync commit.");
  if (pendingChanges(vault) > 0) throw new DockyError(result.stderr || "Could not commit pending vault changes.");
  return result.ok;
}

function conflictFiles(vault: string): string[] {
  const out = runGit(vault, ["diff", "--name-only", "--diff-filter=U"], { allowFailure: true }).stdout;
  return out ? out.split("\n").filter(Boolean) : [];
}

/** Configure the device-local cloud binding. No remote command is executed;
 * turning the switch off is therefore a hard guarantee of zero network I/O. */
export function configureSync(vault: string, options: SyncOptions): SyncStatus {
  vault = path.resolve(vault);
  ensureRepo(vault);
  ensureIgnored(vault);
  // Migrate v1 config before the first cloud commit so absolute local project
  // paths move into ignored .docky/local.yaml.
  saveConfig(vault, loadConfig(vault));

  if (options.branch !== undefined) {
    const valid = runGit(vault, ["check-ref-format", "--branch", options.branch], { allowFailure: true });
    if (!valid.ok) throw new DockyError(`Invalid cloud branch: ${options.branch}`);
    setGitConfig(vault, "docky.sync.branch", options.branch);
  }

  if (options.remote !== undefined) {
    const remote = options.remote.trim();
    if (!remote) throw new DockyError("Cloud remote must not be empty.");
    const existing = runGit(vault, ["remote", "get-url", REMOTE_NAME], { allowFailure: true });
    runGit(vault, existing.ok ? ["remote", "set-url", REMOTE_NAME, remote] : ["remote", "add", REMOTE_NAME, remote]);
  }

  if (options.enabled !== undefined) {
    if (options.enabled && !runGit(vault, ["remote", "get-url", REMOTE_NAME], { allowFailure: true }).ok) {
      throw new DockyError("Cloud remote is not connected. Run `docky cloud connect <remote>` first.");
    }
    setGitConfig(vault, "docky.sync.enabled", String(options.enabled));
    writeState(vault, { state: options.enabled ? "idle" : "off", conflicts: [] });
  }
  if (!gitConfig(vault, "docky.sync.branch")) {
    setGitConfig(vault, "docky.sync.branch", DEFAULT_REMOTE_BRANCH);
  }
  return getSyncStatus(vault);
}

/** Read local status only. This interface never contacts the remote. */
export function getSyncStatus(vault: string): SyncStatus {
  vault = path.resolve(vault);
  if (!fs.existsSync(gitDir(vault))) {
    return {
      enabled: false,
      connected: false,
      branch: DEFAULT_REMOTE_BRANCH,
      state: "error",
      pendingChanges: 0,
      ahead: 0,
      behind: 0,
      lastError: "Vault is not a Git repository.",
      conflicts: [],
    };
  }
  const enabled = gitConfig(vault, "docky.sync.enabled") === "true";
  const branch = gitConfig(vault, "docky.sync.branch") || DEFAULT_REMOTE_BRANCH;
  const remoteResult = runGit(vault, ["remote", "get-url", REMOTE_NAME], { allowFailure: true });
  const persisted = readState(vault);
  const counts = aheadBehind(vault, branch);
  const pending = pendingChanges(vault);
  let state: SyncState = enabled ? persisted.state : "off";
  if (enabled && state === "idle" && (pending > 0 || counts.ahead > 0)) state = "pending";
  return {
    enabled,
    connected: remoteResult.ok,
    remote: remoteResult.ok ? remoteResult.stdout : undefined,
    branch,
    state,
    pendingChanges: pending,
    ahead: counts.ahead,
    behind: counts.behind,
    lastSyncedAt: persisted.lastSyncedAt,
    lastError: persisted.lastError,
    conflicts: persisted.conflicts ?? [],
  };
}

/** Synchronize one workspace as a single state transition. Local writes are
 * committed before network access; any network or merge failure leaves those
 * commits intact and returns a pending/error status instead of deleting data. */
export function syncWorkspace(vault: string, trigger: SyncTrigger = "manual"): SyncResult {
  vault = path.resolve(vault);
  const initial = getSyncStatus(vault);
  if (!initial.enabled) return { status: initial, committed: false, pulled: 0, pushed: false };
  if (!initial.connected) {
    const status = { ...initial, state: "error" as const, lastError: "Cloud remote is not connected." };
    writeState(vault, { state: status.state, lastError: status.lastError, conflicts: [] });
    return { status, committed: false, pulled: 0, pushed: false };
  }

  let fd: number | undefined;
  let committed = false;
  let pulled = 0;
  let pushed = false;
  const networkTimeout = trigger === "automatic" ? 5_000 : 30_000;
  try {
    fd = acquireLock(vault);
    writeState(vault, { state: "syncing", conflicts: [] });
    committed = commitPending(vault);
    const branch = initial.branch;
    runGit(vault, ["fetch", "--prune", "--no-tags", REMOTE_NAME], { timeoutMs: networkTimeout });

    const remoteExists = refExists(vault, remoteRef(branch));
    if (remoteExists) {
      const counts = aheadBehind(vault, branch);
      pulled = counts.behind;
      if (counts.behind > 0) {
        const rebase = runGit(vault, ["rebase", remoteRef(branch)], { allowFailure: true });
        if (!rebase.ok) {
          const conflicts = conflictFiles(vault);
          runGit(vault, ["rebase", "--abort"], { allowFailure: true });
          const state: PersistedState = conflicts.length
            ? { state: "conflict", lastError: "Cloud sync has document conflicts.", conflicts }
            : { state: "error", lastError: rebase.stderr || "Could not rebase cloud changes.", conflicts: [] };
          writeState(vault, state);
          return { status: getSyncStatus(vault), committed, pulled: 0, pushed: false };
        }
      }
    }

    const beforePush = aheadBehind(vault, branch).ahead;
    runGit(vault, ["push", "--set-upstream", REMOTE_NAME, `HEAD:refs/heads/${branch}`], {
      timeoutMs: networkTimeout,
    });
    pushed = !remoteExists || committed || beforePush > 0;
    writeState(vault, { state: "idle", lastSyncedAt: new Date().toISOString(), conflicts: [] });
    return { status: getSyncStatus(vault), committed, pulled, pushed };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // A competing process owns the state file while it owns the lock. Do not
    // overwrite its progress merely because this caller arrived second.
    if (fd === undefined) {
      return {
        status: { ...getSyncStatus(vault), lastError: message },
        committed,
        pulled: 0,
        pushed: false,
      };
    }
    writeState(vault, { state: "error", lastError: message, conflicts: [] });
    return { status: getSyncStatus(vault), committed, pulled: 0, pushed: false };
  } finally {
    if (fd !== undefined) releaseLock(vault, fd);
  }
}
