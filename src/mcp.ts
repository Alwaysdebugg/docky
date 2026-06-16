#!/usr/bin/env node
/**
 * docky MCP server — exposes scope-isolated doc tools to AI agents.
 *
 * Run with:  docky-mcp     (or: npm run mcp / node dist/mcp.js)  — stdio transport.
 *
 * Every tool is confined to a single `project` scope. read_doc/write_doc reject
 * any path that escapes the project directory, so an agent can never reach
 * another project's documents.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as core from "./core.js";
import { getVaultPath } from "./config.js";
import { DockyError } from "./types.js";

const server = new McpServer({ name: "docky", version: "0.1.0" });

function vault(): string {
  return getVaultPath();
}

function text(value: unknown) {
  const str = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text: str }] };
}

function fail(e: unknown) {
  const msg = e instanceof DockyError ? e.message : `Error: ${(e as Error).message}`;
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

server.registerTool(
  "resolve_project",
  {
    description:
      "Infer the project that owns a working directory (via path + git branch). " +
      "Returns {project, branch, matched}. Throws if the directory is not registered — " +
      "the server never falls back to a global scope.",
    inputSchema: { cwd: z.string().describe("Absolute working directory path.") },
  },
  async ({ cwd }) => {
    try {
      const ctx = core.resolveProject(vault(), cwd);
      return text({ project: ctx.project, branch: ctx.branch, matched: ctx.root });
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "list_docs",
  {
    description:
      "List documents within a project's scope (optionally filtered by type). " +
      "Prefer calling this (and reading INDEX) before pulling full doc bodies.",
    inputSchema: {
      project: z.string(),
      type: z.string().optional().describe("design | plan | debug | code-review | prompts"),
    },
  },
  async ({ project, type }) => {
    try {
      const docs = core.listDocs(vault(), project, type);
      return text(docs.map((d) => ({ type: d.type, title: d.title, rel: d.rel })));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "read_doc",
  {
    description:
      "Read a single document by its project-relative path (e.g. design/x.md). " +
      "Paths that escape the project scope are refused.",
    inputSchema: { project: z.string(), path: z.string() },
  },
  async ({ project, path: rel }) => {
    try {
      return text(core.readDoc(vault(), project, rel));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "search_docs",
  {
    description: "Keyword-search documents inside a project's scope.",
    inputSchema: { project: z.string(), query: z.string(), type: z.string().optional() },
  },
  async ({ project, query, type }) => {
    try {
      const hits = core.searchDocs(vault(), project, query, type);
      return text(hits.map((h) => ({ rel: h.rel, title: h.title, line: h.line, snippet: h.snippet })));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "write_doc",
  {
    description: "Write/overwrite a document into <project>/<type>/<name>.md (scope-checked).",
    inputSchema: {
      project: z.string(),
      type: z.string(),
      name: z.string(),
      content: z.string(),
    },
  },
  async ({ project, type, name, content }) => {
    try {
      const dest = core.writeDoc(vault(), project, type, name, content);
      return text({ path: dest, rel: `${type}/${dest.split("/").pop()}` });
    } catch (e) {
      return fail(e);
    }
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
