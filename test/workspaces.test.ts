import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listWorkspaces,
  registerWorkspace,
  resolveWorkspace,
  setActiveWorkspace,
} from "../src/workspaces.js";

let tmp: string;
let registry: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docky-workspaces-"));
  registry = path.join(tmp, "workspaces.yaml");
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("workspace registry", () => {
  it("keeps the legacy default workspace when no registry exists", () => {
    const items = listWorkspaces(registry);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("default");
    expect(items[0].active).toBe(true);
  });

  it("registers, selects, and explicitly resolves named workspaces", () => {
    const work = path.join(tmp, "work");
    const client = path.join(tmp, "client-a");
    registerWorkspace("工作", work, registry);
    registerWorkspace("客户A", client, registry);
    setActiveWorkspace("工作", registry);

    expect(resolveWorkspace(undefined, registry)).toMatchObject({ name: "工作", path: work, active: true });
    expect(resolveWorkspace("客户A", registry)).toMatchObject({ name: "客户A", path: client, source: "explicit" });
    expect(listWorkspaces(registry).map((w) => w.name)).toEqual(["工作", "default", "客户A"]);
  });

  it("rejects unknown names and path-like workspace names", () => {
    expect(() => registerWorkspace("../escape", tmp, registry)).toThrow(/name/i);
    expect(() => setActiveWorkspace("missing", registry)).toThrow(/Unknown workspace/);
  });
});
