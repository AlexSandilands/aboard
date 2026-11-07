import { describe, expect, it } from "vitest";
import { hintsFor, pausedText, spendText, weekBars } from "./health.logic";

describe("weekBars", () => {
  it("scales each day to the busiest, with its failed part", () => {
    const bars = weekBars([
      { date: "2026-11-01", runs: 0, failed: 0 },
      { date: "2026-11-02", runs: 4, failed: 1 },
      { date: "2026-11-03", runs: 2, failed: 2 },
    ]);
    expect(bars.map((b) => [b.height, b.failedHeight])).toEqual([
      [0, 0],
      [1, 0.25],
      [0.5, 0.5],
    ]);
  });

  it("keeps an empty week flat", () => {
    expect(weekBars([{ date: "d", runs: 0, failed: 0 }])[0]?.height).toBe(0);
  });
});

describe("text", () => {
  it("formats spend", () => {
    expect(spendText(0)).toBe("$0");
    expect(spendText(0.004)).toBe("$0.004");
    expect(spendText(1.836)).toBe("$1.84");
  });

  it("says where an automation paused itself", () => {
    const pause = { automation: "a", projectId: "p", projectTitle: "storefront", reason: "", pausedAt: "" };
    expect(pausedText([])).toBeNull();
    expect(pausedText([pause])).toBe("Paused in storefront");
    expect(pausedText([pause, { ...pause, projectId: "q" }])).toBe("Paused in 2 projects");
  });

  it("picks the hints about one automation, or Autopilot-wide ones", () => {
    const hint = (automation: string | null) => ({
      id: String(automation),
      automation,
      tone: "info" as const,
      text: "",
      action: { kind: "open_limits" as const, label: "" },
    });
    const hints = [hint("a"), hint(null), hint("b")];
    expect(hintsFor(hints, "a").map((h) => h.id)).toEqual(["a"]);
    expect(hintsFor(hints, null).map((h) => h.id)).toEqual(["null"]);
  });
});
