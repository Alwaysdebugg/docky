/**
 * Claude Code hook integration — pure logic, no I/O, so it is unit-testable.
 *
 * - `guardDecision`: PreToolUse handler. Given the hook's stdin JSON, decide
 *   whether to block a Write/Edit of a process-doc Markdown file and redirect
 *   the agent to docky's write_doc.
 * - `contextText`: SessionStart handler. Build the context string injected into
 *   the agent (policy + the current project's existing docs).
 * - `mergeHooks`: idempotently merge docky hook entries into a settings object.
 */
import path from "node:path";
import * as core from "./core.js";

// Common repo docs that are NOT process docs — never block these.
const WHITELIST = /^(README|CHANGELOG|CONTRIBUTING|LICENSE|AGENTS|CLAUDE)/;

/**
 * Returns the deny-JSON string to print (block), or null to allow.
 */
export function guardDecision(stdinJson: string, vault: string): string | null {
  let p = "";
  try {
    const d = JSON.parse(stdinJson || "{}");
    p = d?.tool_input?.file_path || d?.tool_input?.path || "";
  } catch {
    return null; // unpar. input -> don't block
  }
  if (!p) return null;
  const lower = p.toLowerCase();
  if (!lower.endsWith(".md") && !lower.endsWith(".markdown")) return null; // only markdown
  if (WHITELIST.test(path.basename(p).toUpperCase())) return null; // allow standard repo docs

  const resolved = path.resolve(p);
  const v = path.resolve(vault);
  if (resolved === v || resolved.startsWith(v + path.sep)) return null; // allow writes into the vault

  // Allow the Claude Code agent memory directory (…/.claude/**/memory/**): those
  // are the agent's own persistent memory files, not project process docs.
  const segs = resolved.split(path.sep);
  const claudeIdx = segs.indexOf(".claude");
  if (claudeIdx !== -1 && segs.slice(claudeIdx + 1).includes("memory")) return null;

  const reason =
    `过程文档请用 docky 管理:调用 docky 的 write_doc(project, type, name, content) ` +
    `写入中心仓库,而不是在项目里创建 ${p}。类型: design / plan / debug / code-review / prompts。`;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

/** Build the SessionStart context string (policy + current project's docs). */
export function contextText(vault: string, cwd: string, initialized: boolean): string {
  const lines = [
    "## docky 文档政策",
    "过程文档(design / plan / debug / code-review / prompts)统一由 docky 管理。" +
      "需要读或写这类文档时,优先用 docky MCP:先 resolve_project,再 list_docs / search_docs / read_doc;写用 write_doc。" +
      "不要在仓库里直接新建或读取散落的 .md。",
  ];
  if (initialized) {
    try {
      const ctx = core.resolveProject(vault, cwd);
      // Scope the injected doc list to the current branch when branchScope is on (F56).
      const scope = core.scopedProject(vault, ctx.project, ctx.branch);
      const docs = core.listDocs(vault, scope);
      const onBranch = core.branchScopeEnabled(vault) ? ` @ ${ctx.branch ?? "-"}` : "";
      lines.push("", `### 当前项目: ${ctx.project}${onBranch}(${docs.length} 篇)`);
      for (const d of docs) lines.push(`- ${d.rel} — ${d.title}`);
    } catch {
      lines.push("", "(当前目录未注册到 docky;可在 docky 界面用 /init 注册。)");
    }
  }
  return lines.join("\n");
}

export interface HookEntry {
  event: string;
  matcher?: string;
  command: string;
}

/** The hook entries docky installs into Claude Code settings. */
export const DOCKY_HOOK_ENTRIES: HookEntry[] = [
  { event: "SessionStart", command: "docky hooks context" },
  { event: "PreToolUse", matcher: "Edit|Write", command: "docky hooks guard" },
];

/** Idempotently merge hook entries into a settings object. */
export function mergeHooks(
  settings: Record<string, any>,
  entries: HookEntry[]
): { settings: Record<string, any>; added: string[] } {
  settings.hooks = settings.hooks || {};
  const added: string[] = [];
  for (const e of entries) {
    const arr = (settings.hooks[e.event] = settings.hooks[e.event] || []);
    const exists = arr.some((g: any) =>
      (g?.hooks ?? []).some((h: any) => h?.command === e.command)
    );
    if (exists) continue;
    const group = e.matcher
      ? { matcher: e.matcher, hooks: [{ type: "command", command: e.command }] }
      : { hooks: [{ type: "command", command: e.command }] };
    arr.push(group);
    added.push(`${e.event}${e.matcher ? ` (${e.matcher})` : ""} → ${e.command}`);
  }
  return { settings, added };
}
