import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { Config, DOC_TYPES } from "./types.js";

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
  return { version: 1, types: [...DOC_TYPES], projects: {} };
}

export function loadConfig(vault: string): Config {
  const cp = configPath(vault);
  if (!fs.existsSync(cp)) return defaultConfig();
  const data = (yaml.load(fs.readFileSync(cp, "utf-8")) as Partial<Config>) || {};
  return {
    version: data.version ?? 1,
    types: data.types ?? [...DOC_TYPES],
    projects: data.projects ?? {},
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
