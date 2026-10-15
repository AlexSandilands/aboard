import { describe, expect, it } from "vitest";
import { LABELS_PER_TASK_MAX, normalizeLabel, normalizeLabels } from "./labels.ts";

describe("normalizeLabel", () => {
  it("lowercases, trims and drops a leading #", () => {
    expect(normalizeLabel("  UI ")).toBe("ui");
    expect(normalizeLabel("#Backend")).toBe("backend");
  });
  it("turns whitespace and commas into single dashes", () => {
    expect(normalizeLabel("Tech  debt")).toBe("tech-debt");
    expect(normalizeLabel("a, b")).toBe("a-b");
    expect(normalizeLabel(" - ")).toBe("");
  });
});

describe("normalizeLabels", () => {
  it("dedupes after normalising, keeping first-seen order", () => {
    expect(normalizeLabels(["Server", "ui", "SERVER", "#ui"])).toEqual(["server", "ui"]);
  });
  it("rejects empty and over-long labels, and too many", () => {
    expect(() => normalizeLabels(["  "])).toThrow(/empty/);
    expect(() => normalizeLabels(["x".repeat(33)])).toThrow(/longer/);
    const many = Array.from({ length: LABELS_PER_TASK_MAX + 1 }, (_, i) => `l${i}`);
    expect(() => normalizeLabels(many)).toThrow(/at most/);
  });
});
