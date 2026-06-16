/**
 * Markdown rendering + same-terminal pager, so docs can be read without
 * leaving docky / switching apps.
 */
import { spawn, spawnSync } from "node:child_process";
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
 * NOTE: when called from inside an Ink app, the caller must drop raw mode and
 * pause stdin first (Ink owns the TTY otherwise).
 */
export function spawnPager(rendered: string): boolean {
  if (!process.stdout.isTTY) return false;
  const [cmd, ...args] = (process.env.PAGER || "less -R").split(/\s+/);
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

/**
 * Open a file with the OS default application (macOS `open`, Windows `start`,
 * else `xdg-open`). Non-blocking; errors are swallowed.
 */
export function openExternally(filePath: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", filePath] : [filePath];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* ignore */
  }
}
