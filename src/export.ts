/**
 * Export docky documents out of docky (F17): self-contained single-file HTML,
 * per-doc HTML/Markdown, or a full static site. Reuses F03 badges, F12 link
 * resolution (→ in-site anchors), and F08-committed content. Export is confined
 * to the project scope (it only ever reads `core.listDocs`/`readDoc`).
 */
import fs from "node:fs";
import path from "node:path";
import { Marked } from "marked";
import * as core from "./core.js";
import { DocInfo, DockyError } from "./types.js";
import { resolveLink } from "./links.js";

// A fresh Marked instance → HTML (the shared singleton is configured for ANSI).
const md = new Marked();

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Filesystem-safe page name for a doc rel (e.g. design/x.md → design__x). */
function slug(rel: string): string {
  return rel.replace(/\.md$/i, "").replace(/[\\/]/g, "__");
}

const CSS = `
:root{color-scheme:light dark}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;max-width:800px;margin:2rem auto;padding:0 1.2rem;line-height:1.65;color:#24292f}
h1,h2,h3{line-height:1.25} code{background:#f0f1f3;border-radius:4px;padding:.1em .3em} pre{background:#f6f8fa;border-radius:8px;padding:14px;overflow:auto}
pre code{background:none;padding:0} a{color:#0969da;text-decoration:none} a:hover{text-decoration:underline}
table{border-collapse:collapse} th,td{border:1px solid #d0d7de;padding:6px 12px}
.badges{margin:.2rem 0 1rem} .badge{display:inline-block;padding:1px 9px;border-radius:11px;font-size:12px;margin-right:6px}
.status-draft{background:#eaecef;color:#57606a} .status-active{background:#dafbe1;color:#1a7f37} .status-done{background:#ddf4ff;color:#0969da} .status-archived{background:#eaecef;color:#8c959f}
.stale{background:#fff8c5;color:#9a6700} .tag{color:#0969da;font-size:12px;margin-right:6px}
footer.links{margin-top:2rem;padding-top:1rem;border-top:1px solid #d0d7de;font-size:14px;color:#57606a} footer.links a{margin-right:.4rem} .broken{color:#cf222e}
`;

function page(title: string, inner: string): string {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${CSS}</style></head>
<body>
${inner}
</body></html>`;
}

function badges(d: DocInfo): string {
  const parts: string[] = [`<span class="badge status-${d.status}">${d.status}</span>`];
  if (d.stale) parts.push(`<span class="badge stale">⚠ stale</span>`);
  for (const t of d.tags) parts.push(`<span class="tag">#${escapeHtml(t)}</span>`);
  return `<div class="badges">${parts.join("")}</div>`;
}

/** Rewrite `[[...]]` wiki links: site → in-site anchor, single → bold text;
 *  unresolved → flagged ⚠ (F12). */
function resolveWiki(body: string, docs: DocInfo[], mode: "site" | "single"): string {
  return body.replace(/\[\[([^\]\n]+)\]\]/g, (_m, raw: string) => {
    const target = resolveLink(docs, raw.trim());
    if (!target) return `**⚠ [[${raw}]]**`;
    if (mode === "site") return `[${raw}](${slug(target)}.html)`;
    return `**${raw}**`;
  });
}

function linksFooter(links: core.DocLinks, mode: "site" | "single"): string {
  const ref = (rel: string) => (mode === "site" ? `<a href="${slug(rel)}.html">${escapeHtml(rel)}</a>` : escapeHtml(rel));
  const parts: string[] = [];
  const outs = links.outlinks.filter((o) => o.rel).map((o) => o.rel as string);
  if (outs.length) parts.push(`<p><strong>出链 →</strong> ${outs.map(ref).join(" · ")}</p>`);
  if (links.backlinks.length) parts.push(`<p><strong>被引用 ←</strong> ${links.backlinks.map(ref).join(" · ")}</p>`);
  if (links.broken.length) {
    parts.push(`<p class="broken"><strong>⚠ 失效 →</strong> ${links.broken.map((b) => escapeHtml(`[[${b}]]`)).join(" · ")}</p>`);
  }
  return parts.length ? `<footer class="links">${parts.join("\n")}</footer>` : "";
}

/** Build a standalone HTML page for one document (scope-checked read). */
export function buildDocPage(vault: string, project: string, rel: string, mode: "site" | "single" = "single"): string {
  const docs = core.listDocs(vault, project);
  const d = docs.find((x) => x.rel === rel);
  if (!d) throw new DockyError(`Document not found: ${rel}`);
  const raw = core.readDoc(vault, project, rel);
  const stripped = raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const bodyHtml = String(md.parse(resolveWiki(stripped, docs, mode)));
  let links: core.DocLinks = { outlinks: [], backlinks: [], broken: [] };
  try {
    links = core.getLinks(vault, project, rel);
  } catch {
    /* links best-effort */
  }
  const home = mode === "site" ? `<p><a href="index.html">← 索引</a></p>` : "";
  return page(d.title, `${home}${badges(d)}\n${bodyHtml}\n${linksFooter(links, mode)}`);
}

/** Build the static-site index page (grouped by type, with badges). */
export function buildIndexPage(vault: string, project: string): string {
  const docs = core.filterDocs(core.listDocs(vault, project)); // archived hidden
  let body = `<h1>${escapeHtml(project)} — 文档索引</h1>`;
  for (const t of [...new Set(docs.map((d) => d.type))]) {
    const group = docs.filter((d) => d.type === t);
    if (!group.length) continue;
    body += `<h2>${escapeHtml(t)}</h2><ul>`;
    for (const d of group) {
      const tags = d.tags.map((x) => `<span class="tag">#${escapeHtml(x)}</span>`).join("");
      const st = d.status !== "active" ? `<span class="badge status-${d.status}">${d.status}</span>` : "";
      const stale = d.stale ? `<span class="badge stale">⚠</span>` : "";
      body += `<li><a href="${slug(d.rel)}.html">${escapeHtml(d.title)}</a> ${st}${stale}${tags}</li>`;
    }
    body += `</ul>`;
  }
  return page(`${project} — 文档索引`, body);
}

/** Generate a self-contained static site under `outDir`. */
export function exportSite(
  vault: string,
  project: string,
  outDir: string
): { count: number; dir: string; index: string } {
  fs.mkdirSync(outDir, { recursive: true });
  const docs = core.filterDocs(core.listDocs(vault, project));
  const index = path.join(outDir, "index.html");
  fs.writeFileSync(index, buildIndexPage(vault, project), "utf-8");
  for (const d of docs) {
    fs.writeFileSync(path.join(outDir, `${slug(d.rel)}.html`), buildDocPage(vault, project, d.rel, "site"), "utf-8");
  }
  return { count: docs.length, dir: outDir, index };
}

/** Export each scoped doc as a standalone HTML or a copied Markdown file. */
export function exportDocs(
  vault: string,
  project: string,
  outDir: string,
  opts: { type?: string; format: "html" | "md" }
): { count: number; dir: string } {
  fs.mkdirSync(outDir, { recursive: true });
  const docs = core.filterDocs(core.listDocs(vault, project, opts.type));
  for (const d of docs) {
    if (opts.format === "md") fs.copyFileSync(d.path, path.join(outDir, `${slug(d.rel)}.md`));
    else fs.writeFileSync(path.join(outDir, `${slug(d.rel)}.html`), buildDocPage(vault, project, d.rel, "single"), "utf-8");
  }
  return { count: docs.length, dir: outDir };
}

/** Export a single document as a self-contained HTML file, ready to send. */
export function shareDoc(vault: string, project: string, rel: string, outPath?: string): string {
  const html = buildDocPage(vault, project, rel, "single");
  const out = path.resolve(outPath ?? `${path.basename(rel).replace(/\.md$/i, "")}.html`);
  fs.writeFileSync(out, html, "utf-8");
  return out;
}
