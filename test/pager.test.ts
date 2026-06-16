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
});
