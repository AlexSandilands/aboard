import { describe, expect, it } from "vitest";
import { foldDiff, lineDiff, parseEvidence } from "./suggestions.logic";

describe("lineDiff", () => {
  it("marks removed, added and unchanged lines", () => {
    expect(lineDiff("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "B" },
      { kind: "same", text: "c" },
      { kind: "added", text: "d" },
    ]);
  });

  it("keeps a large text's unchanged start and end aligned", () => {
    const lines = Array.from({ length: 5_000 }, (_, i) => `l${i}`);
    const changed = lines.map((l) => (l === "l2500" ? "L2500" : l));
    const diff = lineDiff(lines.join("\n"), changed.join("\n"));
    expect(diff.filter((l) => l.kind !== "same")).toEqual([
      { kind: "removed", text: "l2500" },
      { kind: "added", text: "L2500" },
    ]);
  });

  it("ignores line endings", () => {
    expect(lineDiff("a\r\nb\r\n", "a\nb\n").every((l) => l.kind === "same")).toBe(true);
  });
});

describe("foldDiff", () => {
  it("folds long unchanged runs, keeping context around changes", () => {
    const before = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l5", "L5");
    const folded = foldDiff(lineDiff(before, after), 1);
    expect(folded).toEqual([
      { kind: "skipped", count: 4 },
      { kind: "same", text: "l4" },
      { kind: "removed", text: "l5" },
      { kind: "added", text: "L5" },
      { kind: "same", text: "l6" },
      { kind: "skipped", count: 3 },
    ]);
  });
});

describe("parseEvidence", () => {
  it("reads task refs, URLs and notes", () => {
    expect(parseEvidence("#42 slow review")).toEqual({ kind: "task", number: 42, text: "#42 slow review" });
    expect(parseEvidence("https://github.com/o/r/pull/7")).toEqual({
      kind: "url",
      url: "https://github.com/o/r/pull/7",
    });
    expect(parseEvidence("javascript:alert(1)")).toEqual({ kind: "text", text: "javascript:alert(1)" });
  });
});
