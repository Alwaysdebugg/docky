/**
 * Wiki-style document links (F12): parse `[[type/name]]` / `[[name]]`, resolve
 * them to a concrete doc within the project scope (fuzzily, reusing F02's
 * matcher), and build the reverse (backlink) index.
 *
 * Pure module — callers pass in the doc list and bodies, so there is no fs/Ink
 * dependency and everything is unit-testable. Resolution is confined to the
 * docs handed in, so an out-of-scope target simply fails to resolve (broken).
 */
import { DocInfo } from "./types.js";
import { fuzzy } from "./match.js";

const LINK_RE = /\[\[([^\]\n]+)\]\]/g;

/** Extract the raw inner text of each `[[...]]` link, deduped, in order. */
export function extractLinks(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(LINK_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].trim();
    if (raw && !seen.has(raw)) {
      seen.add(raw);
      out.push(raw);
    }
  }
  return out;
}

/**
 * Resolve a raw link target to a doc `rel` within `docs`, or null if none match.
 * Tries, in order: exact rel → exact file name → exact title → fuzzy match.
 */
export function resolveLink(docs: DocInfo[], raw: string): string | null {
  const norm = raw.trim().replace(/^\.\//, "");
  const withMd = norm.endsWith(".md") ? norm : `${norm}.md`;

  // 1. exact rel (with or without .md)
  let hit = docs.find((d) => d.rel === norm || d.rel === withMd);
  if (hit) return hit.rel;

  // 2. exact file name / title
  const base = norm.includes("/") ? norm.slice(norm.lastIndexOf("/") + 1) : norm;
  const baseMd = base.endsWith(".md") ? base : `${base}.md`;
  hit = docs.find((d) => d.name === base || d.name === baseMd || d.title === raw.trim());
  if (hit) return hit.rel;

  // 3. fuzzy fallback (subsequence match on type/title/name)
  const ranked = fuzzy(base.replace(/\.md$/i, ""), docs, (d) => `${d.type}/${d.title} ${d.name}`);
  return ranked.length ? ranked[0].rel : null;
}

export interface ResolvedLink {
  raw: string;
  rel: string | null; // null = broken (no in-scope target)
}

/** Resolve every link found in `body` against `docs`. */
export function outlinksOf(docs: DocInfo[], body: string): ResolvedLink[] {
  return extractLinks(body).map((raw) => ({ raw, rel: resolveLink(docs, raw) }));
}

/**
 * Build the backlink index: target rel → list of source rels that link to it.
 * `bodies` maps each doc rel to its text. Self-links are ignored.
 */
export function buildBacklinks(docs: DocInfo[], bodies: Map<string, string>): Map<string, string[]> {
  const back = new Map<string, string[]>();
  for (const d of docs) {
    const body = bodies.get(d.rel) ?? "";
    for (const raw of extractLinks(body)) {
      const target = resolveLink(docs, raw);
      if (target && target !== d.rel) {
        const arr = back.get(target) ?? [];
        if (!arr.includes(d.rel)) arr.push(d.rel);
        back.set(target, arr);
      }
    }
  }
  return back;
}
