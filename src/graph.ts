/**
 * Relationship graph (F23): build the project's link graph from F12's wiki-links
 * and backlinks, then surface hubs (most in-linked), clusters (connected
 * components), isolates (no links), and broken links. Terminal-readable tree;
 * Graphviz DOT export for F17. Confined to the project scope (reads listDocs).
 */
import fs from "node:fs";
import * as core from "./core.js";
import { buildBacklinks, outlinksOf } from "./links.js";

export interface GraphNode {
  rel: string;
  title: string;
  out: string[]; // resolved out-links
  in: string[]; // backlink sources
  broken: string[]; // unresolved link targets
}

export interface Graph {
  nodes: Map<string, GraphNode>;
  hubs: { rel: string; inDegree: number }[]; // in-degree desc, only > 0
  clusters: string[][]; // connected components of size > 1, largest first
  isolates: string[]; // no in/out links
}

function readBody(p: string): string {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

export function buildGraph(vault: string, project: string): Graph {
  const docs = core.listDocs(vault, project);
  const bodies = new Map(docs.map((d) => [d.rel, readBody(d.path)]));
  const back = buildBacklinks(docs, bodies);

  const nodes = new Map<string, GraphNode>();
  for (const d of docs) {
    const outs = outlinksOf(docs, bodies.get(d.rel) ?? "");
    nodes.set(d.rel, {
      rel: d.rel,
      title: d.title,
      out: outs.filter((o) => o.rel).map((o) => o.rel as string),
      in: back.get(d.rel) ?? [],
      broken: outs.filter((o) => !o.rel).map((o) => o.raw),
    });
  }

  const hubs = [...nodes.values()]
    .map((n) => ({ rel: n.rel, inDegree: n.in.length }))
    .filter((h) => h.inDegree > 0)
    .sort((a, b) => b.inDegree - a.inDegree || a.rel.localeCompare(b.rel));

  // Undirected adjacency (out + in edges) for connected components.
  const adj = new Map<string, Set<string>>();
  for (const n of nodes.values()) {
    if (!adj.has(n.rel)) adj.set(n.rel, new Set());
    for (const o of n.out) {
      adj.get(n.rel)!.add(o);
      if (!adj.has(o)) adj.set(o, new Set());
      adj.get(o)!.add(n.rel);
    }
  }
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const rel of nodes.keys()) {
    if (seen.has(rel)) continue;
    const comp: string[] = [];
    const stack = [rel];
    seen.add(rel);
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const nb of adj.get(cur) ?? []) {
        if (!seen.has(nb) && nodes.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    components.push(comp.sort());
  }
  const clusters = components.filter((c) => c.length > 1).sort((a, b) => b.length - a.length);
  const isolates = [...nodes.values()].filter((n) => n.in.length === 0 && n.out.length === 0).map((n) => n.rel);

  return { nodes, hubs, clusters, isolates };
}

export interface GraphLine {
  rel: string | null; // openable doc, or null for headers/broken markers
  label: string;
}

/** Flatten the graph into terminal-readable lines: hubs (+ neighbors), clusters,
 *  isolates. Shared by `docky graph` and the TUI /graph view. */
export function graphLines(graph: Graph): GraphLine[] {
  const lines: GraphLine[] = [];
  if (graph.hubs.length) {
    lines.push({ rel: null, label: "枢纽" });
    for (const h of graph.hubs.slice(0, 6)) {
      const n = graph.nodes.get(h.rel)!;
      lines.push({ rel: h.rel, label: `★ ${h.rel} (入链 ${h.inDegree})` });
      for (const o of n.out.slice(0, 6)) lines.push({ rel: o, label: `   ├─ ${o}` });
      for (const b of n.broken.slice(0, 3)) lines.push({ rel: null, label: `   └─ ⚠ [[${b}]] 断链` });
    }
  }
  graph.clusters.slice(0, 5).forEach((c, i) => {
    lines.push({ rel: null, label: `簇 ${i + 1} (${c.length} 篇互联)` });
    for (const rel of c.slice(0, 8)) lines.push({ rel, label: `   ${rel}` });
  });
  if (graph.isolates.length) {
    lines.push({ rel: null, label: `孤岛 (${graph.isolates.length})` });
    for (const rel of graph.isolates.slice(0, 10)) lines.push({ rel, label: `   ${rel}` });
  }
  if (lines.length === 0) lines.push({ rel: null, label: "(无任何文档)" });
  return lines;
}

/** Serialize the graph to Graphviz DOT (for F17 / external rendering). */
export function toDot(graph: Graph): string {
  let s = "digraph docky {\n  rankdir=LR;\n";
  for (const n of graph.nodes.values()) {
    for (const o of n.out) s += `  ${JSON.stringify(n.rel)} -> ${JSON.stringify(o)};\n`;
  }
  s += "}\n";
  return s;
}
