import { describe, expect, it } from "vitest";

import { parseInlineMarkdown } from "./inlineMarkdown.logic";

describe("parseInlineMarkdown", () => {
  it("reads emphasis with the delimiter it was written with", () => {
    expect(parseInlineMarkdown("**a** __b__ *c* _d_ ~~e~~")).toEqual([
      { text: "a", marks: [{ type: "bold", delimiter: "**" }] },
      { text: " ", marks: [] },
      { text: "b", marks: [{ type: "bold", delimiter: "__" }] },
      { text: " ", marks: [] },
      { text: "c", marks: [{ type: "italic", delimiter: "*" }] },
      { text: " ", marks: [] },
      { text: "d", marks: [{ type: "italic", delimiter: "_" }] },
      { text: " ", marks: [] },
      { text: "e", marks: [{ type: "strike" }] },
    ]);
  });

  it("reads a link, with emphasis inside it", () => {
    expect(parseInlineMarkdown("[**a** b](https://x.y)")).toEqual([
      {
        text: "a",
        marks: [
          { type: "link", href: "https://x.y" },
          { type: "bold", delimiter: "**" },
        ],
      },
      { text: " b", marks: [{ type: "link", href: "https://x.y" }] },
    ]);
  });

  it("keeps code literal", () => {
    expect(parseInlineMarkdown("`**a**`")).toEqual([{ text: "**a**", marks: [{ type: "code" }] }]);
  });

  it("leaves images, escapes, unclosed and intraword underscores as text", () => {
    for (const text of ["![a](b.png)", String.raw`\*a\*`, "a **b", "snake_case_name", "[a] (b)"]) {
      expect(parseInlineMarkdown(text)).toEqual([{ text, marks: [] }]);
    }
  });
});
