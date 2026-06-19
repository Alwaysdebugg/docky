import { describe, expect, it } from "vitest";
import { buildBacklinks, extractLinks, outlinksOf, resolveLink } from "../src/links.js";
import { DocInfo } from "../src/types.js";

function doc(rel: string, title: string): DocInfo {
  const slash = rel.indexOf("/");
  return {
    project: "p",
    type: rel.slice(0, slash),
    name: rel.slice(slash + 1),
    rel,
    title,
    path: "/x/" + rel,
    status: "active",
    tags: [],
    mtime: 0,
    stale: false,
  };
}

const docs = [
  doc("design/auth.md", "鉴权改造"),
  doc("debug/login.md", "登录排查"),
  doc("plan/rollout.md", "灰度计划"),
];

describe("links (F12)", () => {
  it("extractLinks parses [[...]], deduped, in order", () => {
    expect(extractLinks("see [[debug/login]] and [[灰度计划]] then [[debug/login]] again")).toEqual([
      "debug/login",
      "灰度计划",
    ]);
  });

  it("resolveLink handles type/name, bare name, title, and fuzzy", () => {
    expect(resolveLink(docs, "debug/login")).toBe("debug/login.md");
    expect(resolveLink(docs, "debug/login.md")).toBe("debug/login.md");
    expect(resolveLink(docs, "login")).toBe("debug/login.md"); // bare file name
    expect(resolveLink(docs, "鉴权改造")).toBe("design/auth.md"); // exact title
    expect(resolveLink(docs, "rollout")).toBe("plan/rollout.md");
  });

  it("returns null for a target with no in-scope match (broken / out-of-scope)", () => {
    expect(resolveLink(docs, "nonexistent-xyz")).toBeNull();
    expect(resolveLink(docs, "../secret/leak")).toBeNull(); // never escapes scope
  });

  it("buildBacklinks builds the reverse index and ignores self-links", () => {
    const bodies = new Map([
      ["design/auth.md", "相关 [[debug/login]] 与 [[plan/rollout]];自引 [[design/auth]]"],
      ["debug/login.md", "见设计 [[design/auth]]"],
      ["plan/rollout.md", "无链接"],
    ]);
    const back = buildBacklinks(docs, bodies);
    expect(back.get("debug/login.md")).toEqual(["design/auth.md"]);
    expect(back.get("design/auth.md")).toEqual(["debug/login.md"]); // not itself
    expect(back.get("plan/rollout.md")).toEqual(["design/auth.md"]);
  });

  it("outlinksOf flags broken links", () => {
    const outs = outlinksOf(docs, "[[debug/login]] 与 [[ghost-doc-zzz]]");
    expect(outs.find((o) => o.raw === "debug/login")!.rel).toBe("debug/login.md");
    expect(outs.find((o) => o.raw === "ghost-doc-zzz")!.rel).toBeNull();
  });
});
