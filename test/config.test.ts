import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "../src/core.js";
import { getConfigValue, listConfig, loadConfig, setConfigValue } from "../src/config.js";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docky-config-"));
  vault = path.join(tmp, "vault");
  core.initVault(vault, false);
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("config preferences (F18)", () => {
  it("lists keys with current + default values", () => {
    const map = Object.fromEntries(listConfig(vault).map((r) => [r.key, r]));
    expect(map.autocommit.value).toBe("auto");
    expect(map.theme.value).toBe("dark");
    expect(map.width.value).toBe("0");
  });

  it("get/set persists and round-trips", () => {
    setConfigValue(vault, "theme", "none");
    expect(loadConfig(vault).render.theme).toBe("none");
    setConfigValue(vault, "width", "100");
    expect(loadConfig(vault).render.width).toBe(100);
    setConfigValue(vault, "width", "0"); // 0 → auto (undefined)
    expect(loadConfig(vault).render.width).toBeUndefined();
  });

  it("rejects invalid values and unknown keys", () => {
    expect(() => setConfigValue(vault, "autocommit", "sometimes")).toThrow();
    expect(() => setConfigValue(vault, "theme", "rainbow")).toThrow();
    expect(() => getConfigValue(vault, "nope")).toThrow(/未知配置键/);
    expect(() => setConfigValue(vault, "nope", "x")).toThrow(/未知配置键/);
  });

  it("tolerates an old config missing the new fields (back-compat)", () => {
    // A vault whose config predates staleDays/render still loads with defaults.
    const fresh = path.join(tmp, "old-vault");
    fs.mkdirSync(path.join(fresh, ".docky"), { recursive: true });
    fs.writeFileSync(path.join(fresh, ".docky", "config.yaml"), "version: 1\nprojects: {}\n");
    expect(getConfigValue(fresh, "theme")).toBe("dark");
  });
});
