/**
 * Markdown heading extraction for the reading-view outline / TOC (F16).
 * Pure module — fenced code blocks are skipped so `#` inside code isn't
 * mistaken for a heading. Shared by the TUI outline, `--toc`, and (later) F17.
 */

export interface Heading {
  level: number; // 1–6 (number of leading #)
  title: string;
  line: number; // 1-based source line
}

const FENCE = /^(\s*)(```+|~~~+)/;
const ATX = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** Extract ATX headings (`#`…`######`) with their source line numbers. */
export function extractHeadings(md: string): Heading[] {
  const lines = md.split("\n");
  const out: Heading[] = [];
  let inFence = false;
  let fenceChar = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, "");
    const fm = line.match(FENCE);
    if (fm) {
      const ch = fm[2][0]; // ` or ~
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
      } else if (ch === fenceChar) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const hm = line.match(ATX);
    if (hm) out.push({ level: hm[1].length, title: hm[2].trim(), line: i + 1 });
  }
  return out;
}

/** Render a compact indented table of contents (for `open --toc`). */
export function renderToc(headings: Heading[]): string {
  if (headings.length === 0) return "";
  const minLevel = Math.min(...headings.map((h) => h.level));
  return headings.map((h) => "  ".repeat(h.level - minLevel) + h.title).join("\n");
}
