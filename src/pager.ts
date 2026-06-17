/**
 * Markdown rendering + same-terminal pager, so docs can be read without
 * leaving docky / switching apps.
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { marked } from "marked";
// marked-terminal renders Markdown to ANSI for the terminal.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - types are loose across versions
import { markedTerminal } from "marked-terminal";

let configured = false;
function ensureConfigured(): void {
  if (configured) return;
  // @ts-ignore - markedTerminal returns a marked extension
  marked.use(markedTerminal());
  configured = true;
}

/** Render Markdown source to a colored, terminal-friendly string. */
export function renderMarkdown(src: string): string {
  try {
    ensureConfigured();
    return String(marked.parse(src)).replace(/\n+$/, "");
  } catch {
    return src;
  }
}

/**
 * Pipe rendered content through the user's pager ($PAGER, default `less -R`)
 * in the current terminal. Returns false if not a TTY or the pager failed,
 * so the caller can fall back to plain printing.
 *
 * When `startLine` is given and the pager is `less`, the pager opens scrolled
 * to that line (`less +<n>`) — used by interactive search to land on the
 * matching line. Non-`less` pagers ignore it and open from the top.
 *
 * NOTE: when called from inside an Ink app, the caller must drop raw mode and
 * pause stdin first (Ink owns the TTY otherwise).
 */
export function spawnPager(rendered: string, startLine?: number): boolean {
  if (!process.stdout.isTTY) return false;
  const [cmd, ...args] = (process.env.PAGER || "less -R").split(/\s+/);
  const base = path.basename(cmd);
  if (startLine && startLine > 1 && (base === "less" || base === "more")) {
    args.push(`+${startLine}`); // jump to line on startup
  }
  const res = spawnSync(cmd, args, { input: rendered, stdio: ["pipe", "inherit", "inherit"] });
  return !res.error;
}

/** Convenience for non-Ink contexts (CLI): render + page, else print raw. */
export function viewMarkdown(src: string): void {
  const rendered = renderMarkdown(src);
  if (!spawnPager(rendered)) {
    process.stdout.write(rendered + "\n");
  }
}

/** Page already-formatted text (e.g. a colorized diff) without Markdown rendering. */
export function pageRaw(text: string): void {
  if (!spawnPager(text)) {
    process.stdout.write(text + (text.endsWith("\n") ? "" : "\n"));
  }
}

/** Colorize a unified diff for terminal display (ANSI). */
export function colorizeDiff(diff: string): string {
  return diff
    .split("\n")
    .map((l) => {
      if (l.startsWith("+") && !l.startsWith("+++")) return `\x1b[32m${l}\x1b[0m`; // added → green
      if (l.startsWith("-") && !l.startsWith("---")) return `\x1b[31m${l}\x1b[0m`; // removed → red
      if (l.startsWith("@@")) return `\x1b[36m${l}\x1b[0m`; // hunk → cyan
      return l;
    })
    .join("\n");
}

/**
 * Build a line-aware launch command for a GUI editor that can be started
 * detached (non-blocking, safe to spawn from inside Ink). Returns null for
 * terminal editors (vim/nano/…) or unknown editors, so the caller falls back
 * to the OS default opener.
 */
function guiEditorAtLine(editor: string, filePath: string, line: number): { cmd: string; args: string[] } | null {
  const base = path.basename(editor).replace(/\.(exe|cmd)$/i, "").toLowerCase();
  switch (base) {
    case "code":
    case "code-insiders":
    case "codium":
    case "vscodium":
    case "cursor":
    case "windsurf":
      return { cmd: editor, args: ["-g", `${filePath}:${line}`] };
    case "subl":
    case "sublime_text":
    case "sublime":
    case "atom":
      return { cmd: editor, args: [`${filePath}:${line}`] };
    default:
      return null;
  }
}

/**
 * Open a file in an external app. When `line` is given and $VISUAL/$EDITOR is a
 * known GUI editor that supports line targets (VS Code, Sublime, …), open it at
 * that line; otherwise fall back to the OS default application (macOS `open`,
 * Windows `start`, else `xdg-open`). Non-blocking; errors are swallowed.
 */
export function openExternally(filePath: string, line?: number): void {
  const editor = process.env.VISUAL || process.env.EDITOR || "";
  if (line && line > 0 && editor) {
    const gui = guiEditorAtLine(editor, filePath, line);
    if (gui) {
      trySpawnDetached(gui.cmd, gui.args);
      return;
    }
  }
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", filePath] : [filePath];
  trySpawnDetached(cmd, args);
}

function trySpawnDetached(cmd: string, args: string[]): void {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* ignore */
  }
}
