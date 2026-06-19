/**
 * Knowledge-base insights (F21): a read-only birds-eye aggregation over a
 * project — type × status counts, stale/archived shares, most-referenced docs
 * (F12 backlinks), orphans, tag heat (F03), and a health summary (F19).
 * One pass over listDocs; degrades gracefully if a dependency is absent.
 */
import fs from "node:fs";
import * as core from "./core.js";
import { DOC_TYPES, DocStatus } from "./types.js";
import { buildBacklinks, outlinksOf } from "./links.js";
import { lintProject } from "./lint.js";

export interface TypeStat {
  type: string;
  active: number;
  draft: number;
  done: number;
  archived: number;
  stale: number;
  total: number;
}

export interface Stats {
  total: number;
  byType: TypeStat[];
  statusTotals: Record<DocStatus, number>;
  staleTotal: number;
  mostReferenced: { rel: string; count: number }[];
  orphans: string[]; // no in-links and no resolved out-links
  tagHeat: { tag: string; count: number }[];
  health: { error: number; warn: number; info: number };
}

function readBody(p: string): string {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

export function computeStats(vault: string, project: string): Stats {
  const docs = core.listDocs(vault, project); // all docs (incl. archived) for the matrix
  const bodies = new Map(docs.map((d) => [d.rel, readBody(d.path)]));

  const statusTotals: Record<DocStatus, number> = { draft: 0, active: 0, done: 0, archived: 0 };
  const byTypeMap = new Map<string, TypeStat>();
  for (const t of DOC_TYPES) byTypeMap.set(t, { type: t, active: 0, draft: 0, done: 0, archived: 0, stale: 0, total: 0 });
  let staleTotal = 0;
  const tagCount = new Map<string, number>();

  for (const d of docs) {
    statusTotals[d.status]++;
    const ts = byTypeMap.get(d.type);
    if (ts) {
      ts[d.status]++;
      ts.total++;
      if (d.stale) ts.stale++;
    }
    if (d.stale) staleTotal++;
    for (const tag of d.tags) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
  }

  // F12 references: backlink counts + orphans (no in/out links).
  const back = buildBacklinks(docs, bodies);
  const mostReferenced = docs
    .map((d) => ({ rel: d.rel, count: back.get(d.rel)?.length ?? 0 }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const orphans = docs
    .filter((d) => {
      const inLinks = (back.get(d.rel)?.length ?? 0) > 0;
      const outLinks = outlinksOf(docs, bodies.get(d.rel) ?? "").some((o) => o.rel);
      return !inLinks && !outLinks;
    })
    .map((d) => d.rel);

  const tagHeat = [...tagCount.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, 8);

  // F19 health summary.
  const health = { error: 0, warn: 0, info: 0 };
  for (const i of lintProject(vault, project)) health[i.severity]++;

  return {
    total: docs.length,
    byType: [...byTypeMap.values()].filter((t) => t.total > 0),
    statusTotals,
    staleTotal,
    mostReferenced,
    orphans,
    tagHeat,
    health,
  };
}
