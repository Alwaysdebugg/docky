import * as core from "./core.js";
import { isInitialized } from "./config.js";
import { configureSync, getSyncStatus, syncWorkspace, SyncResult, SyncStatus } from "./sync.js";
import { DockyError } from "./types.js";
import { listWorkspaces, resolveWorkspace, WorkspaceContext } from "./workspaces.js";

export interface CloudSetupIO {
  question(prompt: string): Promise<string>;
  print(message?: string): void;
}

export interface CloudSetupDependencies {
  resolveWorkspace(name?: string): WorkspaceContext;
  listWorkspaces(): WorkspaceContext[];
  isInitialized(vault: string): boolean;
  initialize(vault: string): void;
  getStatus(vault: string): SyncStatus;
  configure(vault: string, options: { remote: string; branch: string; enabled: boolean }): SyncStatus;
  sync(vault: string): SyncResult;
}

export interface CloudSetupOptions {
  /** An explicit global --workspace skips the workspace picker. */
  workspace?: string;
}

export interface CloudSetupResult {
  cancelled: boolean;
  workspace?: WorkspaceContext;
  initialized?: boolean;
  status?: SyncStatus;
  syncResult?: SyncResult;
}

const defaultDependencies: CloudSetupDependencies = {
  resolveWorkspace,
  listWorkspaces,
  isInitialized,
  initialize: (vault) => core.initVault(vault, true),
  getStatus: getSyncStatus,
  configure: (vault, options) => configureSync(vault, options),
  sync: (vault) => syncWorkspace(vault),
};

function uniqueWorkspaces(preferred: WorkspaceContext, listed: WorkspaceContext[]): WorkspaceContext[] {
  const result = [...listed];
  if (!result.some((workspace) => workspace.name === preferred.name && workspace.path === preferred.path)) {
    result.unshift(preferred);
  }
  return result;
}

async function askYesNo(io: CloudSetupIO, prompt: string, defaultValue: boolean): Promise<boolean> {
  const suffix = defaultValue ? "[Y/n]" : "[y/N]";
  while (true) {
    const answer = (await io.question(`${prompt} ${suffix} `)).trim().toLowerCase();
    if (!answer) return defaultValue;
    if (["y", "yes", "是"].includes(answer)) return true;
    if (["n", "no", "否"].includes(answer)) return false;
    io.print("  请输入 y 或 n。");
  }
}

async function askRequired(io: CloudSetupIO, prompt: string, current?: string): Promise<string> {
  while (true) {
    const suffix = current ? ` [当前: ${redactRemote(current)}]` : "";
    const answer = (await io.question(`${prompt}${suffix}: `)).trim();
    if (answer) return answer;
    if (current) return current;
    io.print("  此项不能为空。");
  }
}

async function selectWorkspace(
  io: CloudSetupIO,
  preferred: WorkspaceContext,
  workspaces: WorkspaceContext[],
  explicit: boolean
): Promise<WorkspaceContext> {
  if (explicit) {
    io.print(`  ✓ ${preferred.name} → ${preferred.path}`);
    return preferred;
  }

  const defaultIndex = Math.max(
    0,
    workspaces.findIndex((workspace) => workspace.name === preferred.name && workspace.path === preferred.path)
  );
  workspaces.forEach((workspace, index) => {
    const marker = index === defaultIndex ? "*" : " ";
    io.print(`  ${index + 1}. ${marker} ${workspace.name} → ${workspace.path}`);
  });

  while (true) {
    const answer = (await io.question(`选择 Workspace [${defaultIndex + 1}]: `)).trim();
    if (!answer) return workspaces[defaultIndex];
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < workspaces.length) return workspaces[index];
    const named = workspaces.find((workspace) => workspace.name === answer);
    if (named) return named;
    io.print("  请输入列表编号或完整 Workspace 名称。");
  }
}

/** Prevent credentials embedded in an HTTPS remote from being echoed in the
 * wizard summary. Git/SSH remains responsible for authentication. */
export function redactRemote(remote: string): string {
  try {
    const parsed = new URL(remote);
    if (!parsed.username && !parsed.password) return remote;
    parsed.username = "***";
    parsed.password = "***";
    return parsed.toString();
  } catch {
    return remote;
  }
}

/** Interactive Cloud Sync onboarding. All remote mutations still go through
 * the existing sync engine; the wizard only gathers and confirms options. */
export async function runCloudSetupWizard(
  io: CloudSetupIO,
  options: CloudSetupOptions = {},
  dependencies: CloudSetupDependencies = defaultDependencies
): Promise<CloudSetupResult> {
  io.print("");
  io.print("☁  Docky Cloud Sync 配置向导");
  io.print("   配置保存在当前设备；认证由 Git / SSH 管理。\n");

  const preferred = dependencies.resolveWorkspace(options.workspace);
  const workspaces = uniqueWorkspaces(preferred, dependencies.listWorkspaces());

  io.print("[1/5] 选择 Workspace");
  const workspace = await selectWorkspace(io, preferred, workspaces, Boolean(options.workspace));

  let initialized = false;
  if (!dependencies.isInitialized(workspace.path)) {
    const shouldInitialize = await askYesNo(io, `  ${workspace.name} 尚未初始化，是否现在初始化？`, true);
    if (!shouldInitialize) return { cancelled: true, workspace };
    dependencies.initialize(workspace.path);
    initialized = true;
    io.print("  ✓ Vault 已初始化");
  }

  const current = dependencies.getStatus(workspace.path);

  io.print("\n[2/5] 连接 Git Remote");
  const remote = await askRequired(io, "Remote URL", current.remote);
  io.print("  提示：推荐使用空的私有仓库，例如 git@github.com:you/docky-docs.git");

  io.print("\n[3/5] 设置同步分支");
  const branch = (await io.question(`Branch [${current.branch || "main"}]: `)).trim() || current.branch || "main";

  io.print("\n[4/5] 设置 Cloud Sync 开关");
  const enabled = await askYesNo(io, "开启自动 Cloud Sync？", true);

  io.print("\n[5/5] 确认配置");
  io.print(`  Workspace  ${workspace.name}`);
  io.print(`  Vault      ${workspace.path}`);
  io.print(`  Remote     ${redactRemote(remote)}`);
  io.print(`  Branch     ${branch}`);
  io.print(`  Sync       ${enabled ? "ON" : "OFF"}`);

  const apply = await askYesNo(io, "\n应用以上配置？", true);
  if (!apply) return { cancelled: true, workspace, initialized };

  let status: SyncStatus;
  try {
    status = dependencies.configure(workspace.path, { remote, branch, enabled });
  } catch (error) {
    if (error instanceof DockyError) throw error;
    throw new DockyError(error instanceof Error ? error.message : String(error));
  }

  if (!enabled) return { cancelled: false, workspace, initialized, status };

  const syncNow = await askYesNo(io, "立即执行首次同步？", true);
  if (!syncNow) return { cancelled: false, workspace, initialized, status };
  const syncResult = dependencies.sync(workspace.path);
  return { cancelled: false, workspace, initialized, status: syncResult.status, syncResult };
}
