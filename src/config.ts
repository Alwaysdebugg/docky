import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { AutocommitMode, Config, DOC_TYPES, DockyError } from "./types.js";
import { resolveWorkspace } from "./workspaces.js";

const CONFIG_RELPATH = path.join(".docky", "config.yaml");
const LOCAL_CONFIG_RELPATH = path.join(".docky", "local.yaml");

/** Resolve a named/active workspace while preserving the legacy
 * $DOCKY_VAULT override when no explicit workspace is supplied. */
export function getVaultPath(workspace?: string): string {
  return resolveWorkspace(workspace).path;
}

export function configPath(vault: string): string {
  return path.join(vault, CONFIG_RELPATH);
}

/** Device-local config: absolute project paths and user preferences must never
 * be committed or transferred to another machine. */
export function localConfigPath(vault: string): string {
  return path.join(vault, LOCAL_CONFIG_RELPATH);
}

export function defaultConfig(): Config {
  return {
    version: 2,
    types: [...DOC_TYPES],
    projects: {},
    autocommit: "auto",
    grants: {},
    render: { theme: "dark" },
  };
}

export function loadConfig(vault: string): Config {
  const cp = configPath(vault);
  if (!fs.existsSync(cp)) return defaultConfig();
  const shared = (yaml.load(fs.readFileSync(cp, "utf-8")) as Partial<Config>) || {};
  const lp = localConfigPath(vault);
  const local = fs.existsSync(lp)
    ? ((yaml.load(fs.readFileSync(lp, "utf-8")) as Partial<Config>) || {})
    : {};
  // A v1 vault stored everything in config.yaml. Fall back to those fields
  // until the next save migrates them into local.yaml.
  const mode = local.autocommit ?? shared.autocommit;
  return {
    version: shared.version ?? 1,
    types: shared.types ?? [...DOC_TYPES],
    projects: local.projects ?? shared.projects ?? {},
    autocommit: mode === "manual" || mode === "off" ? mode : "auto",
    grants: shared.grants && typeof shared.grants === "object" ? shared.grants : {},
    render: {
      width:
        typeof local.render?.width === "number"
          ? local.render.width
          : typeof shared.render?.width === "number"
            ? shared.render.width
            : undefined,
      theme: (local.render?.theme ?? shared.render?.theme) === "none" ? "none" : "dark",
    },
  };
}

export function saveConfig(vault: string, cfg: Config): void {
  const cp = configPath(vault);
  fs.mkdirSync(path.dirname(cp), { recursive: true });
  // Only portable, non-sensitive data belongs to the tracked vault config.
  fs.writeFileSync(
    cp,
    yaml.dump({ version: 2, types: cfg.types, grants: cfg.grants }, { sortKeys: false }),
    "utf-8"
  );
  fs.writeFileSync(
    localConfigPath(vault),
    yaml.dump(
      { version: 1, projects: cfg.projects, autocommit: cfg.autocommit, render: cfg.render },
      { sortKeys: false }
    ),
    "utf-8"
  );
}

export function isInitialized(vault: string): boolean {
  return fs.existsSync(configPath(vault));
}

// --------------------------------------------------------------------------- //
// Managed preferences (F18): a registry of settable keys with validation.
// --------------------------------------------------------------------------- //
interface ConfigKeyDef {
  key: string;
  desc: string;
  default: string;
  get: (c: Config) => string;
  set?: (c: Config, value: string) => void; // omit → read-only; throws on invalid
}

export const CONFIG_KEYS: ConfigKeyDef[] = [
  {
    key: "autocommit",
    desc: "F08 自动提交: auto|manual|off",
    default: "auto",
    get: (c) => c.autocommit,
    set: (c, v) => {
      if (!["auto", "manual", "off"].includes(v)) throw new DockyError("autocommit 须为 auto|manual|off");
      c.autocommit = v as AutocommitMode;
    },
  },
  {
    key: "theme",
    desc: "F16 渲染主题: dark|none",
    default: "dark",
    get: (c) => c.render.theme,
    set: (c, v) => {
      if (v !== "dark" && v !== "none") throw new DockyError("theme 须为 dark|none");
      c.render.theme = v;
    },
  },
  {
    key: "width",
    desc: "F16 渲染宽度(0=自适应)",
    default: "0",
    get: (c) => String(c.render.width ?? 0),
    set: (c, v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw new DockyError("width 须为非负整数");
      c.render.width = n === 0 ? undefined : n;
    },
  },
];

function findKey(key: string): ConfigKeyDef {
  const def = CONFIG_KEYS.find((k) => k.key === key);
  if (!def) throw new DockyError(`未知配置键: ${key}(可用: ${CONFIG_KEYS.map((k) => k.key).join(", ")})`);
  return def;
}

export function getConfigValue(vault: string, key: string): string {
  return findKey(key).get(loadConfig(vault));
}

export function setConfigValue(vault: string, key: string, value: string): void {
  const def = findKey(key);
  if (!def.set) throw new DockyError(`配置键只读: ${key}`);
  const cfg = loadConfig(vault);
  def.set(cfg, value); // validates; throws on invalid
  saveConfig(vault, cfg);
}

export function listConfig(vault: string): { key: string; value: string; default: string; desc: string }[] {
  const cfg = loadConfig(vault);
  return CONFIG_KEYS.map((k) => ({ key: k.key, value: k.get(cfg), default: k.default, desc: k.desc }));
}
