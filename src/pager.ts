/**
 * Markdown rendering + same-terminal pager, so docs can be read without
 * leaving docky / switching apps.
 */
import { spawnSync } from "node:child_process";
import { Marked, marked } from "marked";
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

export interface RenderOpts {
  width?: number;
  theme?: "dark" | "none";
}

const ANSI = /\x1b\[[0-9;]*m/g;

/** Render Markdown source to a terminal-friendly string. Width reflows long
 *  lines; theme "none" strips color. Defaults preserve the original output. */
export function renderMarkdown(src: string, opts: RenderOpts = {}): string {
  try {
    if (opts.width || opts.theme === "none") {
      const m = new Marked();
      // @ts-ignore - markedTerminal returns a marked extension
      m.use(markedTerminal(opts.width ? { width: opts.width, reflowText: true } : {}));
      let out = String(m.parse(src)).replace(/\n+$/, "");
      if (opts.theme === "none") out = out.replace(ANSI, "");
      return out;
    }
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
 */
export function spawnPager(rendered: string): boolean {
  if (!process.stdout.isTTY) return false;
  const [cmd, ...args] = (process.env.PAGER || "less -R").split(/\s+/);
  const res = spawnSync(cmd, args, { input: rendered, stdio: ["pipe", "inherit", "inherit"] });
  return !res.error;
}

/** Page already-formatted text without Markdown rendering, else print raw. */
export function pageRaw(text: string): void {
  if (!spawnPager(text)) {
    process.stdout.write(text + (text.endsWith("\n") ? "" : "\n"));
  }
}
