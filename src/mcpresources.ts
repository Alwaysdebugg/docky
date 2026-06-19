/**
 * MCP Resources + Prompts data layer (F25). Pure helpers (no transport) so they
 * are unit-testable; src/mcp.ts wires them to the SDK. Documents are exposed as
 * `docky://<project>/<type>/<name>` resources; reads go through core.readDoc, so
 * `safePath` remains the hard scope boundary (a `../` URI is refused).
 */
import * as core from "./core.js";

export interface ResourceEntry {
  uri: string;
  name: string;
  title: string;
  mimeType: string;
}

export interface PromptMessage {
  role: "user";
  content: { type: "text"; text: string };
}

/** Every document across registered projects, as docky:// resources. */
export function listResources(vault: string): ResourceEntry[] {
  const out: ResourceEntry[] = [];
  for (const project of Object.keys(core.listProjects(vault))) {
    for (const d of core.listDocs(vault, project)) {
      out.push({
        uri: `docky://${project}/${d.rel}`,
        name: `${project}/${d.rel}`,
        title: d.title,
        mimeType: "text/markdown",
      });
    }
  }
  return out;
}

export function parseDockyUri(uri: string): { project: string; rel: string } | null {
  const m = uri.match(/^docky:\/\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  return { project: dec(m[1]), rel: dec(m[2]) };
}

/** Read a docky:// resource's content (scope-checked via core.readDoc). */
export function readResource(vault: string, uri: string): { uri: string; text: string; mimeType: string } {
  const p = parseDockyUri(uri);
  if (!p) throw new Error(`Invalid docky URI: ${uri}`);
  const text = core.readDoc(vault, p.project, p.rel); // safePath rejects out-of-scope rels
  return { uri, text, mimeType: "text/markdown" };
}

/** Prompt: load a project's relevant context (wraps F07 get_context). */
export function contextPromptMessages(vault: string, project: string, query?: string): PromptMessage[] {
  const bundle = core.buildContext(vault, project, { query });
  const body = bundle.items
    .map((i) => `- ${i.rel} [${i.status}] ★${i.score}${i.project ? ` @${i.project}` : ""}\n  ${i.excerpt}`)
    .join("\n");
  const text =
    `项目「${project}」相关上下文${query ? `(查询: ${query})` : ""}:\n${body || "(无)"}` +
    (bundle.note ? `\n${bundle.note}` : "");
  return [{ role: "user", content: { type: "text", text } }];
}

/** Prompt: start a new typed document from its template (wraps F06). */
export function scaffoldPromptMessages(vault: string, docType: string, project: string, name: string): PromptMessage[] {
  const scaffold = core.renderScaffold(vault, docType, name);
  const text =
    `请基于以下 ${docType} 模板撰写文档「${name}」,完成后用 write_doc 存入项目 ${project}` +
    `(默认会进入审阅收件箱,见 F22):\n\n${scaffold}`;
  return [{ role: "user", content: { type: "text", text } }];
}
