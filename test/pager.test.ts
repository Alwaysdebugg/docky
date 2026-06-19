import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/pager.js";

describe("renderMarkdown", () => {
  it("renders a heading into non-empty terminal output", () => {
    const out = renderMarkdown("# Hello\n\nbody text");
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("Hello");
    expect(out).toContain("body text");
  });

  it("renders list items", () => {
    const out = renderMarkdown("- one\n- two");
    expect(out).toContain("one");
    expect(out).toContain("two");
  });

  it("never throws on odd input", () => {
    expect(() => renderMarkdown("```\nunclosed")).not.toThrow();
  });

  it("theme 'none' strips ANSI color (F16)", () => {
    const plain = renderMarkdown("# Hello\n\n**bold** text", { theme: "none" });
    expect(plain).toContain("Hello");
    expect(plain).not.toMatch(/\x1b\[/); // no ANSI escapes
  });

  it("accepts a width option without throwing (F16)", () => {
    expect(() => renderMarkdown("a ".repeat(200), { width: 40 })).not.toThrow();
  });
});
