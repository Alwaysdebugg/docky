import { describe, expect, it } from "vitest";
import { fuzzy, fuzzyScore } from "../src/match.js";

describe("fuzzyScore", () => {
  it("matches a subsequence (non-contiguous)", () => {
    expect(fuzzyScore("lgn", "login")).not.toBeNull();
    expect(fuzzyScore("dsn", "design")).not.toBeNull();
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("LOGIN", "login")).not.toBeNull();
    expect(fuzzyScore("login", "LOGIN")).not.toBeNull();
  });

  it("returns null when characters are missing or out of order", () => {
    expect(fuzzyScore("xyz", "login")).toBeNull();
    expect(fuzzyScore("nigol", "login")).toBeNull(); // reversed order
    expect(fuzzyScore("loginx", "login")).toBeNull(); // longer than target
  });

  it("scores a contiguous/prefix match higher than a scattered one", () => {
    const prefix = fuzzyScore("log", "login")!;
    const scattered = fuzzyScore("lgn", "login")!;
    expect(prefix).toBeGreaterThan(scattered);
  });

  it("scores a word-start match higher than a mid-word one", () => {
    const atStart = fuzzyScore("ca", "credit-card")!; // 'c' start, 'a' after '-'
    const midWord = fuzzyScore("re", "credit-card")!; // both mid-word
    expect(atStart).toBeGreaterThan(midWord);
  });

  it("handles CJK characters as a subsequence", () => {
    expect(fuzzyScore("登录", "登录鉴权改造")).not.toBeNull();
    expect(fuzzyScore("登造", "登录鉴权改造")).not.toBeNull();
    expect(fuzzyScore("退款", "登录鉴权改造")).toBeNull();
  });

  it("treats an empty query as a trivial match", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});

describe("fuzzy", () => {
  const docs = [
    { type: "design", title: "登录鉴权改造", name: "login-auth.md" },
    { type: "debug", title: "登录丢 session 排查", name: "login-session.md" },
    { type: "prompts", title: "退款话术", name: "refund-prompt.md" },
  ];
  const toText = (d: (typeof docs)[number]) => `${d.type} ${d.title} ${d.name}`;

  it("returns all items (unchanged order) for an empty query", () => {
    expect(fuzzy("", docs, toText)).toEqual(docs);
  });

  it("filters to only matching items", () => {
    const out = fuzzy("login", docs, toText);
    expect(out).toHaveLength(2);
    expect(out.every((d) => d.name.includes("login"))).toBe(true);
  });

  it("ranks the better match first", () => {
    // 'login-auth' is a tighter, earlier match than 'login-session'.
    const out = fuzzy("loginauth", docs, toText);
    expect(out[0].name).toBe("login-auth.md");
  });

  it("matches on CJK title", () => {
    const out = fuzzy("退款", docs, toText);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("refund-prompt.md");
  });

  it("does not mutate the input array", () => {
    const copy = [...docs];
    fuzzy("login", docs, toText);
    expect(docs).toEqual(copy);
  });
});
