import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { AutocommitMode, Config, DOC_TYPES, DockyError } from "./types.js";

const CONFIG_RELPATH = path.join(".docky", "config.yaml");

/** Resolve the central vault directory: $DOCKY_VAULT, else ~/docky-vault. */
export function getVaultPath(): string {
  const env = process.env.DOCKY_VAULT;
  return path.resolve(env ? expandHome(env) : path.join(os.homedir(), "docky-vault"));
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

export function configPath(vault: string): string {
  return path.join(vault, CONFIG_RELPATH);
}

export function defaultConfig(): Config {
  return {
    version: 1,
    types: [...DOC_TYPES],
    projects: {},
    autocommit: "auto",
    grants: {},
    render: { theme: "dark" },
    branchScope: false,
  };
}

export function loadConfig(vault: string): Config {
  const cp = configPath(vault);
  if (!fs.existsSync(cp)) return defaultConfig();
  const data = (yaml.load(fs.readFileSync(cp, "utf-8")) as Partial<Config>) || {};
  const mode = data.autocommit;
  return {
    version: data.version ?? 1,
    types: data.types ?? [...DOC_TYPES],
    projects: data.projects ?? {},
    autocommit: mode === "manual" || mode === "off" ? mode : "auto",
    grants: data.grants && typeof data.grants === "object" ? data.grants : {},
    render: {
      width: typeof data.render?.width === "number" ? data.render.width : undefined,
      theme: data.render?.theme === "none" ? "none" : "dark",
    },
    branchScope: data.branchScope === true,
  };
}

export function saveConfig(vault: string, cfg: Config): void {
  const cp = configPath(vault);
  fs.mkdirSync(path.dirname(cp), { recursive: true });
  fs.writeFileSync(cp, yaml.dump(cfg, { sortKeys: false }), "utf-8");
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
  {
    key: "branchScope",
    desc: "F56 按分支隔离: true|false(改后跑 docky migrate-branch-scope)",
    default: "false",
    get: (c) => String(c.branchScope),
    set: (c, v) => {
      if (v !== "true" && v !== "false") throw new DockyError("branchScope 须为 true|false");
      c.branchScope = v === "true";
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
