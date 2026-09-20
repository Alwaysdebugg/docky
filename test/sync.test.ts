import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "../src/core.js";
import { configureSync, getSyncStatus, syncWorkspace } from "../src/sync.js";

let tmp: string;
let vault: string;
let remote: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function docPath(root: string, name: string): string {
  return path.join(root, "projects", "p", "branches", core.DEFAULT_BRANCH_BUCKET, "spec", name);
}

function initializeSource(): void {
  core.initVault(vault, true);
  core.registerProject(vault, "p", path.join(tmp, "project-a"));
  core.writeDoc(vault, "p", "spec", "shared", "# Shared\nbase");
}

function connect(root: string): void {
  configureSync(root, { remote, branch: "main" });
  configureSync(root, { enabled: true });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docky-sync-"));
  vault = path.join(tmp, "vault-a");
  remote = path.join(tmp, "cloud.git");
  fs.mkdirSync(remote, { recursive: true });
  git(remote, ["init", "--bare", "-q", "--initial-branch=main"]);
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("Cloud Sync engine", () => {
  it("does not contact a configured remote while the switch is off", () => {
    initializeSource();
    configureSync(vault, { remote: path.join(tmp, "does-not-exist.git") });

    const result = syncWorkspace(vault);
    expect(result.status.state).toBe("off");
    expect(result.pushed).toBe(false);
    expect(fs.existsSync(docPath(vault, "shared.md"))).toBe(true);
  });

  it("pushes a sanitized vault snapshot to an empty cloud remote", () => {
    initializeSource();
    connect(vault);
    const result = syncWorkspace(vault);

    expect(result.status.state).toBe("idle");
    expect(result.pushed).toBe(true);
    expect(git(remote, ["show", "main:projects/p/branches/_unbranched/spec/shared.md"])).toContain("base");
    const sharedConfig = git(remote, ["show", "main:.docky/config.yaml"]);
    expect(sharedConfig).not.toContain(tmp);
    expect(sharedConfig).not.toContain("projects:");
    expect(getSyncStatus(vault).lastSyncedAt).toBeTruthy();
  });

  it("converges non-overlapping edits from two workspace checkouts", () => {
    initializeSource();
    connect(vault);
    expect(syncWorkspace(vault).status.state).toBe("idle");

    const second = path.join(tmp, "vault-b");
    git(tmp, ["clone", "-q", "-b", "main", remote, second]);
    connect(second);

    fs.writeFileSync(docPath(vault, "from-a.md"), "# A\nlocal A\n", "utf-8");
    fs.writeFileSync(docPath(second, "from-b.md"), "# B\nlocal B\n", "utf-8");
    expect(syncWorkspace(second).status.state).toBe("idle");
    const merged = syncWorkspace(vault);

    expect(merged.status.state).toBe("idle");
    expect(merged.pulled).toBeGreaterThan(0);
    expect(fs.readFileSync(docPath(vault, "from-b.md"), "utf-8")).toContain("local B");
    expect(git(remote, ["show", "main:projects/p/branches/_unbranched/spec/from-a.md"])).toContain("local A");
  });

  it("aborts a conflicting rebase and preserves the local document", () => {
    initializeSource();
    connect(vault);
    syncWorkspace(vault);

    const second = path.join(tmp, "vault-b");
    git(tmp, ["clone", "-q", "-b", "main", remote, second]);
    connect(second);

    fs.writeFileSync(docPath(vault, "shared.md"), "# Shared\nfrom A\n", "utf-8");
    expect(syncWorkspace(vault).status.state).toBe("idle");
    fs.writeFileSync(docPath(second, "shared.md"), "# Shared\nfrom B\n", "utf-8");
    const result = syncWorkspace(second);

    expect(result.status.state).toBe("conflict");
    expect(result.status.conflicts).toContain("projects/p/branches/_unbranched/spec/shared.md");
    expect(fs.readFileSync(docPath(second, "shared.md"), "utf-8")).toContain("from B");
    expect(git(second, ["status", "--porcelain"])).toBe("");
  });

  it("keeps local commits pending when the remote is unavailable", () => {
    initializeSource();
    configureSync(vault, { remote: path.join(tmp, "missing.git"), enabled: true });
    fs.writeFileSync(docPath(vault, "offline.md"), "# Offline\nkept locally\n", "utf-8");

    const result = syncWorkspace(vault);
    expect(result.status.state).toBe("error");
    expect(result.status.lastError).toBeTruthy();
    expect(fs.readFileSync(docPath(vault, "offline.md"), "utf-8")).toContain("kept locally");
    expect(git(vault, ["status", "--porcelain"])).toBe("");
  });
});
