import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "../src/core.js";
import {
  contextPromptMessages,
  listResources,
  parseDockyUri,
  readResource,
  scaffoldPromptMessages,
} from "../src/mcpresources.js";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docky-mcp-"));
  vault = path.join(tmp, "vault");
  core.initVault(vault, false);
  core.registerProject(vault, "p", path.join(tmp, "p"));
  core.writeDoc(vault, "p", "spec", "auth", "# 鉴权\nimportant body");
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("MCP resources & prompts (F25)", () => {
  it("lists documents as docky:// resources", () => {
    const res = listResources(vault);
    expect(res.some((r) => r.uri === "docky://p/spec/auth.md")).toBe(true);
    expect(res.every((r) => r.mimeType === "text/markdown")).toBe(true);
  });

  it("parseDockyUri splits project and rel", () => {
    expect(parseDockyUri("docky://p/spec/auth.md")).toEqual({ project: "p", rel: "spec/auth.md" });
    expect(parseDockyUri("not-a-docky-uri")).toBe(null);
  });

  it("readResource reads in scope and refuses path traversal", () => {
    expect(readResource(vault, "docky://p/spec/auth.md").text).toContain("important body");
    expect(() => readResource(vault, "docky://p/../other/x.md")).toThrow(/escapes/);
  });

  it("contextPromptMessages wraps get_context (F07)", () => {
    const msgs = contextPromptMessages(vault, "p", "auth");
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content.text).toContain("spec/auth.md");
  });

  it("scaffoldPromptMessages wraps the type template (F06)", () => {
    const msgs = scaffoldPromptMessages(vault, "tasks", "p", "登录超时");
    expect(msgs[0].content.text).toContain("任务清单"); // tasks template section
    expect(msgs[0].content.text).toContain("登录超时");
  });
});
