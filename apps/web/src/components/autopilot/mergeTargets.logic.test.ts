import { describe, expect, it } from "vitest";
import { epicsStatus, flaggedStatus, mergeTargetsInfo, refList } from "./mergeTargets.logic";

const task = (number: number, extra: Record<string, unknown> = {}) => ({
  kind: "task" as const,
  number,
  title: `Task ${number}`,
  status: "review" as const,
  archivedAt: null,
  integrationBranch: null,
  autoMerge: null,
  ...extra,
});

describe("mergeTargetsInfo", () => {
  it("finds open integration epics and unfinished flagged tasks that go to main", () => {
    const info = mergeTargetsInfo([
      task(9, { autoMerge: true }),
      task(5, { kind: "epic", integrationBranch: "epic/5-checkout", title: "Checkout" }),
      task(6, { kind: "epic", integrationBranch: "epic/6-old", status: "done" }),
      task(4, { autoMerge: true }),
      task(7, { autoMerge: true, integrationBranch: "epic/5-checkout" }),
      task(8, { autoMerge: true, status: "done" }),
      task(10, { autoMerge: true, archivedAt: "2026-01-01" }),
      task(11),
    ]);
    expect(info.epics).toEqual([{ number: 5, title: "Checkout", branch: "epic/5-checkout" }]);
    expect(info.flagged.map((t) => t.number)).toEqual([4, 9]);
  });
});

describe("the statuses", () => {
  const items = [1, 2, 3].map((n) => ({ number: n, title: `T${n}` }));

  it("names at most two and counts the rest", () => {
    expect(refList(items.slice(0, 1))).toBe("#1 T1");
    expect(refList(items.slice(0, 2))).toBe("#1 T1 and #2 T2");
    expect(refList(items)).toBe("#1 T1, #2 T2 and 1 more");
  });

  it("says one fact for each target", () => {
    expect(epicsStatus({ epics: [], flagged: [] })).toBe("No epic uses one yet");
    expect(epicsStatus({ epics: [{ number: 5, title: "Checkout", branch: "epic/5" }], flagged: [] })).toBe(
      "1 epic: #5 Checkout",
    );
    expect(flaggedStatus({ epics: [], flagged: [] })).toBe("No task is flagged Auto-merge");
    expect(flaggedStatus({ epics: [], flagged: items.slice(0, 2) })).toBe("2 flagged: #1 T1 and #2 T2");
  });
});
