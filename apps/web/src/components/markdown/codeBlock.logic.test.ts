import { describe, expect, it } from "vitest";
import { codeLanguageOf, segmentCode } from "./codeBlock.logic";

describe("codeLanguageOf", () => {
  it("reads the fence's language, by any of its names", () => {
    expect(codeLanguageOf("language-ts")).toBe("typescript");
    expect(codeLanguageOf("language-TSX")).toBe("tsx");
    expect(codeLanguageOf("language-bash")).toBe("shell");
    expect(codeLanguageOf("hljs language-yml")).toBe("yaml");
  });

  it("is null for no language or one that isn't highlighted", () => {
    expect(codeLanguageOf(undefined)).toBeNull();
    expect(codeLanguageOf("")).toBeNull();
    expect(codeLanguageOf("language-brainfuck")).toBeNull();
  });
});

describe("segmentCode", () => {
  it("cuts the text into plain and highlighted segments", () => {
    expect(
      segmentCode("const a = 1;", [
        { from: 0, to: 5, className: "tok-keyword" },
        { from: 10, to: 11, className: "tok-number" },
      ]),
    ).toEqual([
      { text: "const", className: "tok-keyword" },
      { text: " a = ", className: null },
      { text: "1", className: "tok-number" },
      { text: ";", className: null },
    ]);
  });

  it("gives the text back whole whatever the ranges", () => {
    const code = "abcdef";
    const ranges = [
      { from: 1, to: 4, className: "x" },
      { from: 2, to: 5, className: "y" },
      { from: 5, to: 99, className: "z" },
    ];
    expect(
      segmentCode(code, ranges)
        .map((s) => s.text)
        .join(""),
    ).toBe(code);
    expect(segmentCode(code, [])).toEqual([{ text: code, className: null }]);
  });
});
