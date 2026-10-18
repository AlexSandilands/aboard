import type { AutopilotAutomation, AutopilotRun, AutopilotScopeEntry, AutopilotStatus } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  AUTOPILOT_MODES,
  BOARD_MODES,
  automationTitle,
  boardModeToSave,
  boardSummary,
  boardSwitchValue,
  dismissableRun,
  entryFor,
  hasEpicAutomations,
  scopeAutomations,
  epicActiveRuns,
  epicPillState,
  fieldText,
  formatCost,
  inheritLabel,
  isClockTime,
  parentEntry,
  parseLimit,
  parseNumberField,
  pillState,
  pillTooltip,
  projectActiveRuns,
  runsSummary,
  runStatusLabel,
  scopeRowModel,
  scheduledAgentRuns,
  scheduledAnswerOf,
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

describe("board switch", () => {
  it("offers On and Off, without Inherit", () => {
    expect(BOARD_MODES.map((mode) => mode.value)).toEqual(["on", "off"]);
    expect(AUTOPILOT_MODES.map((mode) => mode.value)).toEqual(["inherit", "on", "off"]);
  });

  it("shows no row (inherit) as Off", () => {
    expect(boardSwitchValue("inherit")).toBe("off");
    expect(boardSwitchValue("off")).toBe("off");
    expect(boardSwitchValue("on")).toBe("on");
  });

  it("saves Off as inherit, so the row goes unless it holds config", () => {
    expect(boardModeToSave("off")).toBe("inherit");
    expect(boardModeToSave("on")).toBe("on");
  });

  it("summarises the choice without mentioning Inherit", () => {
    expect(boardSummary("on")).toBe("On for the board");
    expect(boardSummary("off")).toBe("Off for the board");
    expect(boardSummary("inherit")).toBe("Off for the board");
  });
});

describe("inheritLabel", () => {
  it("says what Inherit resolves to from the board's entry", () => {
    expect(inheritLabel({ enabled: true, source: "board" })).toBe("Inherit (On from board)");
    expect(inheritLabel({ enabled: false, source: "board" })).toBe("Inherit (Off from board)");
  });

  it("is off by default with no parent, while the board's entries load", () => {
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

describe("scopeRowModel", () => {
  it("fades an inherited switch and says where it comes from", () => {
    expect(scopeRowModel({ mode: "inherit", enabled: true, source: "board" }, null, "project")).toEqual({
      checked: true,
      inherited: true,
      nextMode: "off",
      canToggle: true,
      blocked: null,
      note: "On, following the board",
    });
    expect(scopeRowModel({ mode: "inherit", enabled: false, source: "default" }, null, "project")).toMatchObject({
      checked: false,
      inherited: true,
      nextMode: "on",
      note: "Off by default",
    });
  });

  it("follows the project for an epic, whatever the board says", () => {
    const row = scopeRowModel({ mode: "inherit", enabled: false, source: "project" }, null, "epic");
    expect(row.note).toBe("Off, following the project");
  });

  it("shows a switch set here as solid, with its own state", () => {
    expect(scopeRowModel({ mode: "on", enabled: true, source: "project" }, null, "project")).toMatchObject({
      checked: true,
      inherited: false,
      nextMode: "off",
      note: "On for this project",
    });
    expect(scopeRowModel({ mode: "off", enabled: false, source: "epic" }, null, "epic")).toMatchObject({
      checked: false,
      inherited: false,
      nextMode: "on",
      note: "Off for this epic",
    });
  });

  it("won't turn a blocked automation on, but turns it off", () => {
    const off = scopeRowModel({ mode: "inherit", enabled: false, source: "default" }, "Pick a tool", "project");
    expect(off).toMatchObject({ canToggle: false, blocked: "Pick a tool" });
    const on = scopeRowModel({ mode: "on", enabled: true, source: "project" }, "Pick a tool", "project");
    expect(on.canToggle).toBe(true);
  });
});

describe("config forms", () => {
  const automation = {
    key: "a",
    title: "A",
    description: "",
    needsAgent: false,
    epicScope: true,
    blocked: null,
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

  it("accepts only a complete 24-hour HH:MM time", () => {
    expect(["00:00", "09:05", "23:59"].every(isClockTime)).toBe(true);
    for (const bad of ["", "9:05", "24:00", "12:60", "12:5", "12:00:00", "ab:cd"]) expect(isClockTime(bad)).toBe(false);
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
    expect(runStatusLabel({ status: "failed", dryRun: false, dedupeKey: "retried:r1:review:pr:l1:abc" })).toBe(
      "Failed, retried",
    );
    expect(runStatusLabel({ status: "skipped", dryRun: false, dedupeKey: "retried:r1:start:t1:x" })).toBe("Retried");
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

describe("dismissableRun", () => {
  const flaggedRun = (id: string, patch: Partial<AutopilotRun> = {}) => ({
    id,
    needsAttention: true,
    dismissedAt: null,
    dryRun: false,
    ...patch,
  });
  const flagged = [{ kind: "autopilot" }];

  it("offers the newest flagged run while the task still carries an Autopilot flag", () => {
    expect(dismissableRun([flaggedRun("new"), flaggedRun("old")], flagged)?.id).toBe("new");
  });

  it("offers nothing once the flag has cleared, even if a run is still marked flagged", () => {
    expect(dismissableRun([flaggedRun("a")], [])).toBeNull();
    expect(dismissableRun([flaggedRun("a")], [{ kind: "attention_request" }])).toBeNull();
  });

  it("skips runs that are dismissed, unflagged or dry", () => {
    const runs = [
      flaggedRun("dismissed", { dismissedAt: "2026-10-18T00:00:00.000Z" }),
      flaggedRun("plain", { needsAttention: false }),
      flaggedRun("dry", { dryRun: true }),
    ];
    expect(dismissableRun(runs, flagged)).toBeNull();
    expect(dismissableRun([...runs, flaggedRun("live")], flagged)?.id).toBe("live");
  });
});

describe("scheduled agent runs", () => {
  const scheduled = (automation: string, patch: Partial<AutopilotRun> = {}) =>
    ({ automation, taskId: null, dryRun: false, output: null, ...patch }) as AutopilotRun;

  it("keeps one automation's real task-less runs, newest first, up to the limit", () => {
    const runs = [
      scheduled("custom:a", { id: "1" }),
      scheduled("custom:b", { id: "2" }),
      scheduled("custom:a", { id: "3", dryRun: true }),
      scheduled("custom:a", { id: "4", taskId: "t" }),
      scheduled("custom:a", { id: "5" }),
      scheduled("custom:a", { id: "6" }),
    ];
    expect(scheduledAgentRuns(runs, "custom:a", 2).map((r) => r.id)).toEqual(["1", "5"]);
    expect(scheduledAgentRuns(undefined, "custom:a", 2)).toEqual([]);
  });

  it("reads the summary and handover a run left", () => {
    const output = { kind: "scheduled_agent", summary: "Did it", handover: "Holding #7" };
    expect(scheduledAnswerOf({ output })).toEqual(output);
    expect(scheduledAnswerOf({ output: null })).toBeNull();
    expect(scheduledAnswerOf({ output: { kind: "pr_review", summary: "x" } })).toBeNull();
  });
});
