import type { TaskSummary } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  formatLabelFilter,
  hashHue,
  labelCounts,
  labelHue,
  parseLabelFilter,
  shuffleHue,
  suggestLabels,
  toggleLabel,
} from "./labels.logic";

describe("label hues", () => {
  it("hashes to a stable hue in range", () => {
    expect(hashHue("ui")).toBe(hashHue("ui"));
    expect(hashHue("ui")).not.toBe(hashHue("backend"));
    for (const label of ["", "a", "tech-debt", "😀"]) {
      expect(hashHue(label)).toBeGreaterThanOrEqual(0);
      expect(hashHue(label)).toBeLessThan(360);
    }
  });
  it("prefers the override", () => {
    expect(labelHue("ui", { ui: 12 })).toBe(12);
    expect(labelHue("ui", {})).toBe(hashHue("ui"));
  });
  it("shuffles at least 40° away", () => {
    expect(shuffleHue(350, () => 0)).toBe(30);
    expect(shuffleHue(10, () => 0.9999)).toBe(330);
  });
});

describe("labelCounts", () => {
  it("counts per label, by name", () => {
    const tasks = [{ labels: ["ui", "bug"] }, { labels: ["ui"] }] as TaskSummary[];
    expect(labelCounts(tasks)).toEqual([
      { name: "bug", count: 1 },
      { name: "ui", count: 2 },
    ]);
  });
});

describe("suggestLabels", () => {
  const inUse = ["backend", "bug", "docs", "ui"];
  it("lists unused labels when empty, and offers no new one", () => {
    expect(suggestLabels("", inUse, ["ui"])).toEqual({ existing: ["backend", "bug", "docs"], create: null });
  });
  it("matches on the normalised query, prefix first, and offers to create", () => {
    expect(suggestLabels("B", inUse, [])).toEqual({ existing: ["backend", "bug"], create: "b" });
    expect(suggestLabels("u", inUse, [])).toEqual({ existing: ["ui", "bug"], create: "u" });
    expect(suggestLabels("Bug", inUse, [])).toEqual({ existing: ["bug"], create: null });
    expect(suggestLabels("New thing", inUse, [])).toEqual({ existing: [], create: "new-thing" });
  });
  it("does not offer a label the task already has", () => {
    expect(suggestLabels("ui", inUse, ["ui"])).toEqual({ existing: [], create: null });
  });
});

describe("label filter param", () => {
  it("round-trips, normalising and deduping", () => {
    expect(parseLabelFilter("UI,backend,,ui")).toEqual(["ui", "backend"]);
    expect(parseLabelFilter(undefined)).toEqual([]);
    expect(formatLabelFilter(["ui", "backend"])).toBe("ui,backend");
    expect(formatLabelFilter([])).toBeUndefined();
  });
  it("toggles a label", () => {
    expect(toggleLabel(["ui"], "bug")).toEqual(["ui", "bug"]);
    expect(toggleLabel(["ui", "bug"], "ui")).toEqual(["bug"]);
  });
});
