/**
 * Pure command-execution layer shared by the TUI.
 *
 * `executeCommand` takes the current vault + project + a raw input string and
 * returns the lines to print plus any state changes (project switch, clear,
 * exit). It has no React/Ink dependency, so it is fully unit-testable.
 */
import path from "node:path";
import * as core from "./core.js";
import { listProjects } from "./core.js";
import { DOC_TYPES, DockyError } from "./types.js";

export type Level = "in" | "out" | "info" | "err" | "ok";

export interface OutLine {
  text: string;
  level: Level;
}

export interface CommandResult {
  output: OutLine[];
  project?: string | null; // set to change active project
  clear?: boolean;
  exit?: boolean;
}

export interface CommandSpec {
  name: string;
  usage: string;
  desc: string;
  /** Whether the command expects arguments (affects Enter-to-select in the TUI). */
  args: boolean;
}

/** Catalogue used for /help, the `/` suggestion menu, and Tab completion. */
export const COMMANDS: CommandSpec[] = [
  { name: "help", usage: "/help", desc: "列出全部命令", args: false },
  { name: "init", usage: "/init [项目名] [路径]", desc: "把当前仓库登记为项目(默认用仓库名)并切换", args: false },
  { name: "use", usage: "/use <项目>", desc: "切换当前项目(作用域)", args: true },
  { name: "projects", usage: "/projects", desc: "列出已注册项目", args: false },
  { name: "whoami", usage: "/whoami", desc: "显示当前目录解析到的项目/分支", args: false },
  { name: "list", usage: "/list [类型]", desc: "列出当前项目文档(可按类型)", args: false },
  { name: "search", usage: "/search <关键词>", desc: "在当前项目内全文检索", args: true },
  { name: "open", usage: "/open <相对路径>", desc: "查看文档内容,如 design/x.md", args: true },
  { name: "add", usage: "/add <类型> <路径> [名]", desc: "归档一个 md 到当前项目", args: true },
  { name: "index", usage: "/index", desc: "刷新当前项目 INDEX.md", args: false },
  { name: "mv", usage: "/mv <相对路径> <类型>", desc: "移动文档到另一类型", args: true },
  { name: "rm", usage: "/rm <相对路径>", desc: "删除文档", args: true },
  { name: "link", usage: "/link", desc: "为当前项目建立 symlink(+.gitignore)", args: false },
  { name: "unlink", usage: "/unlink", desc: "移除当前项目的 symlink", args: false },
  { name: "clear", usage: "/clear", desc: "清屏", args: false },
  { name: "exit", usage: "/exit", desc: "退出(别名 /quit)", args: false },
];

const ALIASES: Record<string, string> = { q: "exit", quit: "exit", p: "use", "?": "help", register: "init" };

const TYPES_HINT = DOC_TYPES.join(" / ");

function line(text: string, level: Level = "out"): OutLine {
  return { text, level };
}

function needProject(project: string | null): string {
  if (!project) throw new DockyError("当前没有选中项目,用 /use <项目> 切换。");
  return project;
}

export function executeCommand(vault: string, project: string | null, raw: string): CommandResult {
  const trimmed = raw.trim();
  if (!trimmed) return { output: [] };

  const echo = line(`› ${trimmed}`, "in");

  // Accept both "/cmd" and "cmd".
  const body = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const parts = body.split(/\s+/);
  let cmd = (parts[0] || "").toLowerCase();
  cmd = ALIASES[cmd] ?? cmd;
  const args = parts.slice(1);

  const out: OutLine[] = [echo];
  try {
    switch (cmd) {
      case "help": {
        out.push(line("可用命令:", "info"));
        for (const c of COMMANDS) out.push(line(`  ${c.usage.padEnd(26)} ${c.desc}`));
        out.push(line(`类型: ${TYPES_HINT}`, "info"));
        out.push(line("提示:输入 / 查看命令列表;直接输入文字执行命令也可。", "info"));
        return { output: out };
      }
      case "clear":
        return { output: [], clear: true };
      case "exit":
        return { output: [line("再见 👋", "info")], exit: true };

      case "projects": {
        const ps = listProjects(vault);
        const names = Object.keys(ps);
        if (names.length === 0) {
          out.push(line("还没有注册任何项目(在 shell 里用 docky register)。", "info"));
        } else {
          for (const n of names) out.push(line(`  ${n}  →  ${ps[n].paths.join(", ")}`));
        }
        return { output: out };
      }
      case "init": {
        // Default project name = current git repo name (or cwd basename).
        const root = core.gitRoot(process.cwd());
        const base = root ?? process.cwd();
        const name = args[0] ?? path.basename(base);
        const localPath = args[1] ?? base;
        core.registerProject(vault, name, localPath);
        out.push(line(`已注册 ${name} → ${path.resolve(localPath)}`, "ok"));
        out.push(line(`已切换到项目 ${name}`, "ok"));
        return { output: out, project: name };
      }
      case "use": {
        if (!args[0]) throw new DockyError("用法: /use <项目>");
        const ps = listProjects(vault);
        if (!(args[0] in ps)) {
          throw new DockyError(`未知项目: ${args[0]}(已注册: ${Object.keys(ps).join(", ") || "无"})`);
        }
        out.push(line(`已切换到项目 ${args[0]}`, "ok"));
        return { output: out, project: args[0] };
      }
      case "whoami": {
        const ctx = core.resolveProject(vault, process.cwd());
        out.push(line(`project: ${ctx.project}`, "ok"));
        out.push(line(`branch:  ${ctx.branch ?? "-"}`));
        out.push(line(`matched: ${ctx.root}`));
        return { output: out, project: ctx.project };
      }
      case "list": {
        const proj = needProject(project);
        const type = args[0];
        const docs = core.listDocs(vault, proj, type);
        if (docs.length === 0) out.push(line("(无文档)", "info"));
        for (const d of docs) out.push(line(`  ${d.type.padEnd(12)} ${d.title}  (${d.name})`));
        out.push(line(`${docs.length} 篇`, "ok"));
        return { output: out };
      }
      case "search": {
        const proj = needProject(project);
        const query = args.join(" ");
        if (!query) throw new DockyError("用法: /search <关键词>");
        const hits = core.searchDocs(vault, proj, query, undefined);
        if (hits.length === 0) out.push(line(`无命中: '${query}'`, "info"));
        for (const h of hits) {
          const loc = h.line ? `${h.rel}:${h.line}` : h.rel;
          out.push(line(`  ${loc}  ${h.snippet}`));
        }
        out.push(line(`${hits.length} 条命中`, "ok"));
        return { output: out };
      }
      case "open": {
        const proj = needProject(project);
        if (!args[0]) throw new DockyError("用法: /open <相对路径>");
        const content = core.readDoc(vault, proj, args[0]);
        for (const l of content.split("\n")) out.push(line(l));
        return { output: out };
      }
      case "add": {
        const proj = needProject(project);
        if (args.length < 2) throw new DockyError("用法: /add <类型> <路径> [新名]");
        const branch = core.gitBranch(process.cwd());
        const dest = core.addDoc(vault, proj, args[0], args[1], {
          branch,
          withFrontmatter: true,
          newName: args[2],
        });
        out.push(line(`已归档 ${path.basename(path.dirname(dest))}/${path.basename(dest)}`, "ok"));
        return { output: out };
      }
      case "index": {
        const proj = needProject(project);
        const p = core.generateIndex(vault, proj);
        out.push(line(`已刷新 ${path.basename(p)}`, "ok"));
        return { output: out };
      }
      case "mv": {
        const proj = needProject(project);
        if (args.length < 2) throw new DockyError("用法: /mv <相对路径> <目标类型>");
        const dest = core.moveDoc(vault, proj, args[0], args[1]);
        out.push(line(`已移动到 ${path.basename(path.dirname(dest))}/${path.basename(dest)}`, "ok"));
        return { output: out };
      }
      case "rm": {
        const proj = needProject(project);
        if (!args[0]) throw new DockyError("用法: /rm <相对路径>");
        core.removeDoc(vault, proj, args[0]);
        out.push(line(`已删除 ${args[0]}`, "ok"));
        return { output: out };
      }
      case "link": {
        const proj = needProject(project);
        const link = core.linkProject(vault, proj);
        out.push(line(`已建立 symlink: ${link}`, "ok"));
        return { output: out };
      }
      case "unlink": {
        const proj = needProject(project);
        core.unlinkProject(vault, proj);
        out.push(line("已移除 symlink", "ok"));
        return { output: out };
      }
      default:
        out.push(line(`未知命令: /${cmd}(输入 /help 查看)`, "err"));
        return { output: out };
    }
  } catch (e) {
    const msg = e instanceof DockyError ? e.message : `错误: ${(e as Error).message}`;
    out.push(line(msg, "err"));
    return { output: out };
  }
}

/** Suggestions for the `/` menu / Tab completion, filtered by a typed prefix. */
export function suggest(input: string): CommandSpec[] {
  if (!input.startsWith("/")) return [];
  const frag = input.slice(1).split(/\s+/)[0].toLowerCase();
  if (input.slice(1).includes(" ")) return []; // already past the command word
  return COMMANDS.filter((c) => c.name.startsWith(frag));
}
