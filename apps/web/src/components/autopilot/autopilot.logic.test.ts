import type { AutopilotAutomation, AutopilotScopeEntry, AutopilotStatus } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  automationTitle,
  entryFor,
  hasEpicAutomations,
  scopeAutomations,
  epicActiveRuns,
  epicPillState,
  fieldText,
  formatCost,
  inheritLabel,
  parentEntry,
  parseLimit,
  parseNumberField,
  pillState,
  pillTooltip,
  projectActiveRuns,
  runsSummary,
  runStatusLabel,
  taskActiveRun,
  withConfigValue,
} from "./autopilot.logic";

const run = (
  taskId: string | null,
  projectId: string | null,
  status: "queued" | "running" = "running",
  epicId: string | null = null,
) => ({
  id: `${taskId}-${projectId}`,
  automation: "review_prs",
  taskId,
  projectId,
  status,
  epicId,
});

const status = (active: AutopilotStatus["active"] = [], paused = false): AutopilotStatus => ({ paused, active });

describe("pillState", () => {
  const on = [{ enabled: false }, { enabled: true }];
  it("is off when nothing is on for the project, or the scope hasn't loaded", () => {
    expect(pillState(status(), "p1", [{ enabled: false }])).toBe("off");
    expect(pillState(status(), "p1", [])).toBe("off");
    expect(pillState(status(), "p1", undefined)).toBe("off");
  });

  it("is idle when something is on and nothing runs", () => {
    expect(pillState(status(), "p1", on)).toBe("idle");
  });

  it("is active while a run in this project is going, whatever the switches or pause say", () => {
    const going = status([run("t1", "p1")], true);
    expect(pillState(going, "p1", on)).toBe("active");
    expect(pillState(going, "p1", [{ enabled: false }])).toBe("active");
  });

  it("ignores runs in other projects and board-wide runs", () => {
    expect(pillState(status([run("t1", "p2"), run(null, null)]), "p1", on)).toBe("idle");
  });

  it("shows paused for an enabled project when Pause all is set", () => {
    expect(pillState(status([], true), "p1", on)).toBe("paused");
    expect(pillState(status([], true), "p1", [{ enabled: false }])).toBe("off");
  });
});

describe("scopeAutomations", () => {
  const all = [
    { key: "unblock", epicScope: true },
    { key: "archive", epicScope: false },
    { key: "recurring", epicScope: false },
  ];
  it("lists every automation for the board and a project, and only those that apply to epics for an epic", () => {
    expect(scopeAutomations(all, false).map((a) => a.key)).toEqual(["unblock", "archive", "recurring"]);
    expect(scopeAutomations(all, true).map((a) => a.key)).toEqual(["unblock"]);
  });

  it("has nothing for an epic's button to open unless some automation applies to epics", () => {
    expect(hasEpicAutomations(all)).toBe(true);
    expect(hasEpicAutomations(all.filter((a) => !a.epicScope))).toBe(false);
    expect(hasEpicAutomations([])).toBe(false);
  });
});

describe("epicPillState", () => {
  const on = [{ enabled: false }, { enabled: true }];
  it("is off when nothing is on for the epic, or its scope hasn't loaded", () => {
    expect(epicPillState(status(), "e1", [{ enabled: false }])).toBe("off");
    expect(epicPillState(status(), "e1", undefined)).toBe("off");
  });

  it("is idle when something is on, whether the epic sets it or inherits it", () => {
    expect(epicPillState(status(), "e1", on)).toBe("idle");
  });

  it("is active while a run on one of the epic's tasks is going, whatever the switches or pause say", () => {
    const going = status([run("t1", "p1", "running", "e1")], true);
    expect(epicPillState(going, "e1", on)).toBe("active");
    expect(epicPillState(going, "e1", [{ enabled: false }])).toBe("active");
  });

  it("ignores runs in other epics, loose runs and runs only in the same project", () => {
    const others = status([run("t1", "p1", "running", "e2"), run("t2", "p1")]);
    expect(epicPillState(others, "e1", on)).toBe("idle");
    expect(epicActiveRuns(others, "e1")).toEqual([]);
  });

  it("shows paused for an epic with something on when Pause all is set", () => {
    expect(epicPillState(status([], true), "e1", on)).toBe("paused");
    expect(epicPillState(status([], true), "e1", [{ enabled: false }])).toBe("off");
  });

  it("words the tooltip for an epic", () => {
    expect(pillTooltip("idle", 0, "epic")).toBe("Autopilot is on for this epic");
    expect(pillTooltip("off", 0, "epic")).toBe("Autopilot is off for this epic");
    expect(pillTooltip("paused", 0, "epic")).toBe("Autopilot is on for this epic, but paused");
    expect(pillTooltip("idle", 0)).toBe("Autopilot is on for this project");
  });
});

describe("active runs", () => {
  it("finds a project's runs and a task's run", () => {
    const s = status([run("t1", "p1"), run("t2", "p1", "queued"), run("t3", "p2")]);
    expect(projectActiveRuns(s, "p1")).toHaveLength(2);
    expect(taskActiveRun(s, "t2")?.status).toBe("queued");
    expect(taskActiveRun(s, "nope")).toBeUndefined();
    expect(taskActiveRun(undefined, "t1")).toBeUndefined();
  });

  it("words the tooltip by state", () => {
    expect(pillTooltip("active", 1)).toBe("Autopilot is working on 1 run");
    expect(pillTooltip("active", 3)).toBe("Autopilot is working on 3 runs");
    expect(pillTooltip("off", 0)).toContain("off");
  });
});

describe("inheritLabel", () => {
  it("says what Inherit resolves to from the board's entry", () => {
    expect(inheritLabel({ enabled: true, source: "board" })).toBe("Inherit (On from board)");
    expect(inheritLabel({ enabled: false, source: "board" })).toBe("Inherit (Off from board)");
  });

  it("is off by default with no parent, as for the board itself or while it loads", () => {
    expect(inheritLabel(null)).toBe("Inherit (Off by default)");
    expect(inheritLabel({ enabled: false, source: "default" })).toBe("Inherit (Off by default)");
  });

  it("says what an epic inherits from its project's entry, which already resolves through the board", () => {
    // The project turned it off; the board had it on.
    const project = [{ automation: "a", enabled: false, source: "project" }] as AutopilotScopeEntry[];
    expect(inheritLabel(parentEntry(project, "a"))).toBe("Inherit (Off from project)");
    const fromBoard = [{ automation: "a", enabled: true, source: "board" }] as AutopilotScopeEntry[];
    expect(inheritLabel(parentEntry(fromBoard, "a"))).toBe("Inherit (On from board)");
  });

  it("finds the board's entry for an automation", () => {
    const entries = [{ automation: "a", enabled: true, source: "board" }] as AutopilotScopeEntry[];
    expect(parentEntry(entries, "a")?.enabled).toBe(true);
    expect(parentEntry(entries, "b")).toBeNull();
    expect(parentEntry(undefined, "a")).toBeNull();
  });
});

describe("config forms", () => {
  const automation = {
    key: "a",
    title: "A",
    description: "",
    needsAgent: false,
    epicScope: true,
    fields: [],
    defaults: { budget: 2 },
  } satisfies AutopilotAutomation;

  it("stands in for an entry that hasn't loaded", () => {
    expect(entryFor(undefined, automation)).toMatchObject({
      automation: "a",
      mode: "inherit",
      config: {},
      effectiveConfig: { budget: 2 },
    });
  });

  it("sets a key, or clears it so it inherits, without touching the others", () => {
    expect(withConfigValue({ budget: 5, tier: "fast" }, "budget", 7)).toEqual({ budget: 7, tier: "fast" });
    expect(withConfigValue({ budget: 5, tier: "fast" }, "budget", undefined)).toEqual({ tier: "fast" });
  });

  it("parses a number field: empty inherits, out of range or text is rejected", () => {
    const field = { min: 1, max: 10 };
    expect(parseNumberField("", field)).toBeUndefined();
    expect(parseNumberField(" 4.5 ", field)).toBe(4.5);
    expect(parseNumberField("0", field)).toBeNull();
    expect(parseNumberField("11", field)).toBeNull();
    expect(parseNumberField("abc", field)).toBeNull();
    expect(parseNumberField("-3", {})).toBe(-3);
  });

  it("shows only numbers and strings in inputs", () => {
    expect(fieldText(3)).toBe("3");
    expect(fieldText("x")).toBe("x");
    expect(fieldText(null)).toBe("");
    expect(fieldText({ source: "builtin" })).toBe("");
  });
});

describe("parseLimit", () => {
  const whole = { min: 1, max: 1000, integer: true };
  it("treats empty as no limit", () => {
    expect(parseLimit("  ", whole)).toBeNull();
  });

  it("accepts numbers in range and rejects the rest", () => {
    expect(parseLimit("25", whole)).toBe(25);
    expect(parseLimit("0", whole)).toBeUndefined();
    expect(parseLimit("1001", whole)).toBeUndefined();
    expect(parseLimit("2.5", whole)).toBeUndefined();
    expect(parseLimit("x", whole)).toBeUndefined();
    expect(parseLimit("2.5", { min: 0.01, max: 100, integer: false })).toBe(2.5);
  });
});

describe("runs", () => {
  it("labels statuses, telling a dry run from a skip", () => {
    expect(runStatusLabel({ status: "skipped", dryRun: true })).toBe("Dry run");
    expect(runStatusLabel({ status: "skipped", dryRun: false })).toBe("Skipped");
    expect(runStatusLabel({ status: "succeeded", dryRun: false })).toBe("Done");
  });

  it("formats cost, keeping sub-cent amounts visible", () => {
    expect(formatCost(null)).toBeNull();
    expect(formatCost(0.4213)).toBe("$0.42");
    expect(formatCost(0.004)).toBe("$0.004");
    expect(formatCost(0)).toBe("$0.00");
  });

  it("falls back to the key for an automation that is no longer in the catalogue", () => {
    expect(automationTitle([{ key: "a", title: "Archive done" }], "a")).toBe("Archive done");
    expect(automationTitle([], "gone")).toBe("gone");
  });

  it("summarizes a task's runs", () => {
    expect(runsSummary([])).toBe("No runs");
    expect(runsSummary([{ status: "succeeded", needsAttention: false }])).toBe("1 run");
    expect(
      runsSummary([
        { status: "running", needsAttention: false },
        { status: "failed", needsAttention: true },
      ]),
    ).toBe("2 runs · 1 running · 1 needs attention");
  });
});
