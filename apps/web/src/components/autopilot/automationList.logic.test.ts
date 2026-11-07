import type { AutopilotAutomation, AutopilotScopeEntry } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  advancedChanged,
  automationReach,
  groupAutomations,
  isOffEverywhere,
  lastRunText,
  rowSubline,
  selectedAutomation,
  statusLine,
  whereText,
} from "./automationList.logic";

const entry = (automation: string, enabled: boolean): AutopilotScopeEntry => ({
  automation,
  mode: "inherit",
  config: {},
  enabled,
  source: enabled ? "board" : "default",
  effectiveConfig: {},
});

describe("groupAutomations", () => {
  it("lists the groups in order, keeps the catalogue's order inside each and leaves out empty ones", () => {
    const item = (key: string, group: AutopilotAutomation["group"]) => ({ automation: { key, group } });
    const groups = groupAutomations([
      item("archive", "upkeep"),
      item("custom:1", "yours"),
      item("start", "ship"),
      item("digest", "upkeep"),
    ]);
    expect(groups.map((g) => [g.label, g.items.map((i) => i.automation.key)])).toEqual([
      ["Ship work", ["start"]],
      ["Upkeep", ["archive", "digest"]],
      ["Yours", ["custom:1"]],
    ]);
  });
});

describe("where an automation is on", () => {
  const projects = (on: boolean[]) => on.map((enabled, i) => ({ title: `p${i + 1}`, entries: [entry("a", enabled)] }));

  it("names the projects it is on in, or every project", () => {
    expect(whereText(automationReach("a", entry("a", true), projects([true, true, true])))).toBe("every project");
    expect(whereText(automationReach("a", entry("a", false), projects([true, false, false])))).toBe("p1");
    expect(whereText(automationReach("a", entry("a", false), projects([true, true, true, true, false])))).toBe(
      "p1, p2 +2",
    );
  });

  it("dims a row only when the automation is off on the board and in every project", () => {
    expect(isOffEverywhere(automationReach("a", entry("a", false), projects([false, false])))).toBe(true);
    // Switched on for one project only: not off, though the board's switch is.
    expect(isOffEverywhere(automationReach("a", entry("a", false), projects([false, true])))).toBe(false);
    // On for the board with no project yet.
    expect(isOffEverywhere(automationReach("a", entry("a", true), []))).toBe(false);
    // A project whose scope is still loading counts as off.
    expect(isOffEverywhere(automationReach("a", undefined, [{ title: "p", entries: undefined }]))).toBe(true);
  });

  it("says Off under a dimmed row, and where and the last run under one that is on", () => {
    const now = Date.parse("2026-11-07T12:00:00Z");
    const off = automationReach("a", entry("a", false), projects([false]));
    expect(rowSubline(off, undefined, now)).toBe("Off");
    expect(statusLine(off)).toBe("Off");
    const on = automationReach("a", entry("a", true), projects([true, true]));
    expect(rowSubline(on, { automation: "a", status: "failed", at: "2026-11-07T11:58:00Z" }, now)).toBe(
      "every project · ✗ 2m",
    );
    expect(rowSubline(on, undefined, now)).toBe("every project · no runs yet");
    expect(statusLine(on)).toBe("On · every project");
    expect(lastRunText({ automation: "a", status: "succeeded", at: "2026-11-07T09:00:00Z" }, now)).toBe("✓ 3h");
  });
});

describe("advancedChanged", () => {
  const automation = {
    fields: [
      { key: "days", label: "Days", kind: "number" as const, tier: "essential" as const },
      { key: "budget", label: "Budget", kind: "number" as const },
      { key: "skill", label: "Skill", kind: "skill" as const, tier: "advanced" as const },
    ],
    defaults: { days: 14, budget: 5, skill: { source: "builtin" } },
  };

  it("is set when an advanced value isn't its default", () => {
    expect(advancedChanged(automation, { days: 14, budget: 5, skill: { source: "builtin" } })).toBe(false);
    expect(advancedChanged(automation, { budget: 7 })).toBe(true);
    expect(advancedChanged(automation, { skill: { source: "global", name: "mine" } })).toBe(true);
  });

  it("ignores essential fields, which show anyway", () => {
    expect(advancedChanged(automation, { days: 30 })).toBe(false);
  });
});

describe("selectedAutomation", () => {
  it("picks the one asked for when it exists, else the first", () => {
    expect(selectedAutomation(["a", "b"], "b")).toBe("b");
    expect(selectedAutomation(["a", "b"], "gone")).toBe("a");
    expect(selectedAutomation(["a", "b"], undefined)).toBe("a");
    expect(selectedAutomation([], "a")).toBeNull();
  });
});
