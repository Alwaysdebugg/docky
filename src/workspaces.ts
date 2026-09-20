import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { DockyError } from "./types.js";

export interface WorkspaceEntry {
  path: string;
}

interface WorkspaceRegistry {
  version: 1;
  active: string;
  workspaces: Record<string, WorkspaceEntry>;
}

export interface WorkspaceContext {
  name: string;
  path: string;
  active: boolean;
  source: "explicit" | "environment" | "registry" | "default";
}

/** Device-local registry. It is deliberately outside every vault, so selecting
 * and locating workspaces can never leak through cloud sync. */
export function workspaceRegistryPath(): string {
  return path.join(os.homedir(), ".docky", "workspaces.yaml");
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function defaultRegistry(): WorkspaceRegistry {
  return {
    version: 1,
    active: "default",
    workspaces: { default: { path: path.join(os.homedir(), "docky-vault") } },
  };
}

function validName(name: string): boolean {
  const n = name.trim();
  return Boolean(n && n !== "." && n !== ".." && !/[\\/\0\r\n]/.test(n));
}

function normalizeRegistry(raw: Partial<WorkspaceRegistry> | null | undefined): WorkspaceRegistry {
  const fallback = defaultRegistry();
  const workspaces: Record<string, WorkspaceEntry> = { ...fallback.workspaces };
  if (raw?.workspaces && typeof raw.workspaces === "object") {
    for (const [name, entry] of Object.entries(raw.workspaces)) {
      if (!validName(name) || !entry || typeof entry.path !== "string" || !entry.path.trim()) continue;
      workspaces[name] = { path: path.resolve(expandHome(entry.path)) };
    }
  }
  const active = typeof raw?.active === "string" && raw.active in workspaces ? raw.active : "default";
  return { version: 1, active, workspaces };
}

function loadRegistry(file: string): WorkspaceRegistry {
  if (!fs.existsSync(file)) return defaultRegistry();
  try {
    return normalizeRegistry((yaml.load(fs.readFileSync(file, "utf-8")) as Partial<WorkspaceRegistry>) || {});
  } catch (e) {
    throw new DockyError(`Workspace registry is invalid at ${file}: ${(e as Error).message}`);
  }
}

function saveRegistry(file: string, registry: WorkspaceRegistry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, yaml.dump(registry, { sortKeys: false }), "utf-8");
  fs.renameSync(tmp, file);
}

/** Resolve one workspace. An explicit name wins; otherwise DOCKY_VAULT keeps
 * its legacy precedence, followed by DOCKY_WORKSPACE and the active registry
 * entry. */
export function resolveWorkspace(
  name?: string,
  registryFile = workspaceRegistryPath()
): WorkspaceContext {
  const registry = loadRegistry(registryFile);
  if (name) {
    const entry = registry.workspaces[name];
    if (!entry) throw new DockyError(`Unknown workspace: ${name}`);
    return { name, path: path.resolve(expandHome(entry.path)), active: name === registry.active, source: "explicit" };
  }

  const legacyPath = process.env.DOCKY_VAULT;
  if (legacyPath) {
    return {
      name: "environment",
      path: path.resolve(expandHome(legacyPath)),
      active: false,
      source: "environment",
    };
  }

  const envName = process.env.DOCKY_WORKSPACE;
  if (envName) {
    const entry = registry.workspaces[envName];
    if (!entry) throw new DockyError(`Unknown workspace from DOCKY_WORKSPACE: ${envName}`);
    return {
      name: envName,
      path: path.resolve(expandHome(entry.path)),
      active: envName === registry.active,
      source: "environment",
    };
  }

  const entry = registry.workspaces[registry.active] ?? registry.workspaces.default;
  return {
    name: registry.active,
    path: path.resolve(expandHome(entry.path)),
    active: true,
    source: fs.existsSync(registryFile) ? "registry" : "default",
  };
}

export function listWorkspaces(registryFile = workspaceRegistryPath()): WorkspaceContext[] {
  const registry = loadRegistry(registryFile);
  return Object.entries(registry.workspaces)
    .map(([name, entry]) => ({
      name,
      path: path.resolve(expandHome(entry.path)),
      active: name === registry.active,
      source: "registry" as const,
    }))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

export function registerWorkspace(
  name: string,
  workspacePath: string,
  registryFile = workspaceRegistryPath()
): WorkspaceContext {
  name = name.trim();
  if (!validName(name)) throw new DockyError("Workspace name must not be empty or contain path separators.");
  const registry = loadRegistry(registryFile);
  const resolved = path.resolve(expandHome(workspacePath));
  registry.workspaces[name] = { path: resolved };
  saveRegistry(registryFile, registry);
  return { name, path: resolved, active: name === registry.active, source: "registry" };
}

export function setActiveWorkspace(
  name: string,
  registryFile = workspaceRegistryPath()
): WorkspaceContext {
  const registry = loadRegistry(registryFile);
  const entry = registry.workspaces[name];
  if (!entry) throw new DockyError(`Unknown workspace: ${name}`);
  registry.active = name;
  saveRegistry(registryFile, registry);
  return { name, path: path.resolve(expandHome(entry.path)), active: true, source: "registry" };
}
