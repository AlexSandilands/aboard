import { describe, expect, it } from "vitest";
import { holdLabel, holdTitle } from "./hold.logic";

const hold = (waiting: number) => ({
  machineId: "m",
  machineName: "engine",
  since: "2026-11-15T09:00:00.000Z",
  waiting,
});

describe("a held task's badge", () => {
  it("names the machine", () => {
    expect(holdLabel(hold(0))).toBe("On engine");
    expect(holdTitle(hold(0))).toBe(
      "engine holds this task and orders its changes; what you change here goes through it.",
    );
  });

  it("says how many edits made here are waiting for it", () => {
    expect(holdLabel(hold(2))).toBe("On engine · 2 waiting");
    expect(holdTitle(hold(1))).toContain("1 change made here is waiting for it");
    expect(holdTitle(hold(2))).toContain("2 changes made here are waiting for it");
  });
});
