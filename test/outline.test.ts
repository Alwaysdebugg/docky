import { describe, expect, it } from "vitest";
import { extractHeadings, renderToc } from "../src/outline.js";

describe("outline (F16)", () => {
  it("extracts ATX headings with levels and 1-based line numbers", () => {
    const md = "# Title\n\nintro\n\n## Section A\ntext\n\n### Sub\n\n## Section B";
    expect(extractHeadings(md).map((h) => [h.level, h.title, h.line])).toEqual([
      [1, "Title", 1],
      [2, "Section A", 5],
      [3, "Sub", 8],
      [2, "Section B", 10],
    ]);
  });

  it("ignores # inside fenced code blocks", () => {
    const md = "# Real\n\n```\n# not a heading\n## also not\n```\n\n## Real Two";
    expect(extractHeadings(md).map((h) => h.title)).toEqual(["Real", "Real Two"]);
  });

  it("handles ~~~ fences and a trailing # in the ATX heading", () => {
    const md = "# A #\n~~~\n# nope\n~~~\n## B";
    expect(extractHeadings(md).map((h) => h.title)).toEqual(["A", "B"]);
  });

  it("renderToc indents by relative heading level", () => {
    expect(
      renderToc([
        { level: 1, title: "T", line: 1 },
        { level: 2, title: "S", line: 3 },
      ])
    ).toBe("T\n  S");
  });

  it("is empty when there are no headings", () => {
    expect(extractHeadings("just text\nno headings")).toEqual([]);
    expect(renderToc([])).toBe("");
  });
});
