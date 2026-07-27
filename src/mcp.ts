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
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as core from "./core.js";
import { getVaultPath } from "./config.js";
import { DockyError } from "./types.js";
import {
  contextPromptMessages,
  listResources,
  readResource,
  scaffoldPromptMessages,
} from "./mcpresources.js";

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

// Branch isolation key (F56). Optional everywhere: when this vault has
// branchScope enabled, it scopes the call to projects/<name>/<branch>/ — get it
// from resolve_project and pass it back. Omitted/empty → the '_default' bucket.
// When branchScope is off it is ignored, so it is always safe to send.
const BRANCH_ARG = z
  .string()
  .optional()
  .describe("Branch isolation key (F56) from resolve_project. Omit if unknown → '_default' bucket.");

server.registerTool(
  "resolve_project",
  {
    description:
      "Infer the project that owns a working directory (via path + git branch). " +
      "Returns {project, branch, matched}. Throws if the directory is not registered — " +
      "the server never falls back to a global scope. When this vault has branch " +
      "isolation enabled (F56), `branch` is the read/write isolation key: pass it back " +
      "to the other tools so an agent on branch A never sees branch B's docs. " +
      "branchScope reports whether that isolation is active.",
    inputSchema: { cwd: z.string().describe("Absolute working directory path.") },
  },
  async ({ cwd }) => {
    try {
      const ctx = core.resolveProject(vault(), cwd);
      return text({
        project: ctx.project,
        branch: ctx.branch,
        matched: ctx.root,
        branchScope: core.branchScopeEnabled(vault()),
      });
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "list_docs",
  {
    description:
      "List documents within a project's scope. Optionally filter by type, " +
      "lifecycle status, or tag. Archived docs are hidden unless status='archived'. " +
      "Prefer calling this before pulling full doc bodies.",
    inputSchema: {
      project: z.string(),
      branch: BRANCH_ARG,
      type: z.string().optional().describe("design | plan | debug | code-review | prompts"),
      status: z.string().optional().describe("draft | active | done | archived"),
      tag: z.string().optional().describe("Filter to docs carrying this tag."),
    },
  },
  async ({ project, branch, type, status, tag }) => {
    try {
      const scope = core.scopedProject(vault(), project, branch);
      const docs = core.filterDocs(core.listDocs(vault(), scope, type), { status, tag });
      return text(
        docs.map((d) => ({ type: d.type, title: d.title, rel: d.rel, status: d.status, tags: d.tags }))
      );
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
    inputSchema: { project: z.string(), branch: BRANCH_ARG, path: z.string() },
  },
  async ({ project, branch, path: rel }) => {
    try {
      return text(core.readDoc(vault(), core.scopedProject(vault(), project, branch), rel));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "search_docs",
  {
    description:
      "Search a project's docs (relevance-ranked, multi-snippet, hit-highlighted). " +
      "Archived docs are excluded. Pass fuzzy=true for subsequence matching.",
    inputSchema: {
      project: z.string(),
      branch: BRANCH_ARG,
      query: z.string(),
      type: z.string().optional(),
      fuzzy: z.boolean().optional().describe("Fuzzy (subsequence) matching."),
      across: z.boolean().optional().describe("Include granted (read-only) cross-project scopes (F15)."),
    },
  },
  async ({ project, branch, query, type, fuzzy, across }) => {
    try {
      if (across) {
        const hits = core.searchAcross(vault(), project, query, { type, fuzzy, branch });
        return text(
          hits.map((h) => ({
            project: h.project,
            readonly: h.readonly,
            rel: h.rel,
            title: h.title,
            score: h.score,
            snippets: h.snippets,
          }))
        );
      }
      const hits = core.searchDocs(vault(), core.scopedProject(vault(), project, branch), query, type, {}, { fuzzy });
      return text(hits.map((h) => ({ rel: h.rel, title: h.title, score: h.score, snippets: h.snippets })));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "write_doc",
  {
    description:
      "Write a document into <project>/<type>/<name>.md (scope-checked). Smart by " +
      "default (F20): in mode 'new' it will NOT silently overwrite or duplicate — if " +
      "the name exists or a near-duplicate is found, it returns a suggestion instead " +
      "of writing. New docs are date-stamped automatically: a YYYY-MM-DD-HHmm- prefix " +
      "is prepended to `name` (idempotent — skipped when you already lead with an ISO " +
      "date), so pass a plain slug like 'auth-redesign' and let docky add the date. " +
      "append/replace/merge target an existing doc by its exact (already-dated) name " +
      "and do not re-stamp it. Use mode=append (timestamped section), merge (preview), " +
      "or replace (explicit overwrite). scaffold=true prefills the type template (F06).",
    inputSchema: {
      project: z.string(),
      branch: BRANCH_ARG,
      type: z.string(),
      name: z
        .string()
        .describe(
          "Doc slug without extension. For new docs pass a plain slug (e.g. " +
            "'auth-redesign') — docky prepends a YYYY-MM-DD-HHmm date stamp. For " +
            "append/replace/merge pass the existing doc's exact (dated) name."
        ),
      content: z.string().optional(),
      scaffold: z.boolean().optional().describe("Prefill from the type's template skeleton (F06)."),
      mode: z.enum(["new", "append", "merge", "replace"]).optional().describe("Write mode (F20; default new)."),
    },
  },
  async ({ project, branch, type, name, content, scaffold, mode }) => {
    try {
      let body = content ?? "";
      if (scaffold) {
        const skeleton = core.renderScaffold(vault(), type, name.replace(/\.md$/i, ""));
        body = body ? `${skeleton}\n\n${body}` : skeleton;
      }
      const scope = core.scopedProject(vault(), project, branch);
      return text(core.smartWrite(vault(), scope, type, name, body, mode ?? "new"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "get_context",
  {
    description:
      "One-shot relevant-doc bundle for a project: items ranked by relevance " +
      "(when query is given) plus status freshness and recent access, with archived " +
      "docs excluded and the bundle truncated to an approximate token budget. Each " +
      "item carries {rel, type, status, title, score, excerpt}. Prefer this over " +
      "multiple list_docs + read_doc round-trips when gathering context.",
    inputSchema: {
      project: z.string(),
      branch: BRANCH_ARG,
      query: z.string().optional().describe("Focus the bundle on a topic; omit for a project overview."),
      budget: z.number().optional().describe("Approximate token budget; the bundle is truncated to fit."),
      across: z
        .boolean()
        .optional()
        .describe("Also include granted (read-only) cross-project scopes, tagged by source (F15)."),
    },
  },
  async ({ project, branch, query, budget, across }) => {
    try {
      return text(core.buildContext(vault(), project, { query, budget, across, branch }));
    } catch (e) {
      return fail(e);
    }
  }
);

// --------------------------------------------------------------------------- //
// Resources (F25): documents as docky://<project>/<type>/<name>
// --------------------------------------------------------------------------- //
function decVar(v: unknown): string {
  const s = Array.isArray(v) ? String(v[0]) : String(v);
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

server.registerResource(
  "docky-docs",
  new ResourceTemplate("docky://{project}/{type}/{name}", {
    list: () => ({ resources: listResources(vault()) }),
  }),
  {
    title: "docky documents",
    description: "Project documents exposed as readable, browsable resources (scope-checked).",
  },
  async (_uri, variables) => {
    const built = `docky://${decVar(variables.project)}/${decVar(variables.type)}/${decVar(variables.name)}`;
    try {
      const r = readResource(vault(), built);
      return { contents: [{ uri: r.uri, text: r.text, mimeType: r.mimeType }] };
    } catch (e) {
      throw new Error(e instanceof DockyError ? e.message : `Error: ${(e as Error).message}`);
    }
  }
);

// --------------------------------------------------------------------------- //
// Prompts (F25): one-click context / scaffolds
// --------------------------------------------------------------------------- //
server.registerPrompt(
  "load-project-context",
  {
    description: "Load a project's relevant documents as context (wraps get_context / F07).",
    argsSchema: { project: z.string(), query: z.string().optional() },
  },
  ({ project, query }) => ({ messages: contextPromptMessages(vault(), project, query) })
);

server.registerPrompt(
  "start-debug-doc",
  {
    description: "Start a new debug document from the docky template (F06).",
    argsSchema: { project: z.string(), name: z.string() },
  },
  ({ project, name }) => ({ messages: scaffoldPromptMessages(vault(), "debug", project, name) })
);

server.registerPrompt(
  "start-design-doc",
  {
    description: "Start a new design document from the docky template (F06).",
    argsSchema: { project: z.string(), name: z.string() },
  },
  ({ project, name }) => ({ messages: scaffoldPromptMessages(vault(), "design", project, name) })
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
