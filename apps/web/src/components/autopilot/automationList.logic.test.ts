import type { AutopilotAutomation, AutopilotScopeEntry } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  advancedChanged,
  advancedFieldNames,
  agentFieldsTitle,
  agentSummary,
  automationReach,
  groupAutomations,
  isOffEverywhere,
  lastRunText,
  rowSubline,
  selectedAutomation,
  splitAgentFields,
  statusLine,
  switchState,
  onInProjectsText,
  projectsStatus,
  whereText,
} from "./automationList.logic";

const entry = (automation: string, enabled: boolean): AutopilotScopeEntry => ({
  automation,
  mode: "inherit",
  config: {},
  lastOnMode: null,
  enabled,
  preview: false,
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

  it("names the projects it only previews apart from those it runs in", () => {
    const preview = (title: string): { title: string; entries: AutopilotScopeEntry[] } => ({
      title,
      entries: [{ ...entry("a", true), preview: true }],
    });
    const reach = automationReach("a", entry("a", true), [...projects([true]), preview("docs")]);
    expect(reach.previewProjects).toEqual(["docs"]);
    expect(projectsStatus(reach)).toBe("On in p1 · Preview in docs");
    expect(projectsStatus({ projects: ["docs"], previewProjects: ["docs"] })).toBe("Preview in docs");
    expect(projectsStatus({ projects: [], previewProjects: [] })).toBe("On in no project");
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

  it("says Off under a dimmed row, and where and the last run under one that is plainly on", () => {
    const now = Date.parse("2026-11-07T12:00:00Z");
    const off = automationReach("a", entry("a", false), projects([false]));
    expect(rowSubline(off, undefined, { nowMs: now })).toEqual({ word: null, sep: "", text: "Off" });
    expect(statusLine(off)).toBe("Off");
    const on = automationReach("a", entry("a", true), projects([true, true]));
    expect(rowSubline(on, undefined, { nowMs: now })).toEqual({
      word: null,
      sep: "",
      text: "every project · no runs yet",
    });
    expect(statusLine(on)).toBe("On · every project");
    expect(lastRunText({ automation: "a", status: "succeeded", at: "2026-11-07T09:00:00Z" }, now)).toBe("✓ 3h");
  });

  it("leads the subline with the state the switch can't show, in words", () => {
    const now = Date.parse("2026-11-07T12:00:00Z");
    const on = automationReach("a", entry("a", true), projects([true, true]));
    const failed = { automation: "a", status: "failed" as const, at: "2026-11-07T11:57:00Z" };
    expect(rowSubline(on, failed, { nowMs: now })).toEqual({
      word: { text: "Last run failed", tone: "danger" },
      sep: " · ",
      text: "3m ago",
    });
    expect(rowSubline(on, undefined, { nowMs: now, preview: true })).toEqual({
      word: { text: "Preview", tone: "warning" },
      sep: " · ",
      text: "every project · no runs yet",
    });
    // Paused beats Preview and a failed run: it is what stops it running.
    expect(rowSubline(on, failed, { nowMs: now, preview: true, paused: "Paused in storefront" })).toEqual({
      word: { text: "Paused", tone: "warning" },
      sep: " ",
      text: "in storefront",
    });
    // Recurring tasks has no switch, so only its last run.
    expect(rowSubline(off3(), undefined, { nowMs: now, switchless: true }).text).toBe("no runs yet");
  });

  it("reads a board that is off while projects set their own On as mixed, in the subline and status too", () => {
    const now = Date.parse("2026-11-07T12:00:00Z");
    const mixed = automationReach("a", entry("a", false), projects([true, true, true, true, true]));
    expect(switchState(mixed)).toBe("mixed");
    expect(switchState(automationReach("a", entry("a", true), projects([true])))).toBe("on");
    expect(switchState(off3())).toBe("off");
    expect(rowSubline(mixed, undefined, { nowMs: now }).text).toBe("On in 5 projects · no runs yet");
    expect(statusLine(mixed)).toBe("On in 5 projects · Off for the board");
    expect(onInProjectsText({ projects: ["storefront"], previewProjects: [] })).toBe("On in storefront");
  });

  it("names projects only in Preview as Preview, not On, while the board is off", () => {
    const preview = (title: string): { title: string; entries: AutopilotScopeEntry[] } => ({
      title,
      entries: [{ ...entry("a", true), preview: true }],
    });
    const onlyPreview = automationReach("a", entry("a", false), [preview("docs")]);
    expect(statusLine(onlyPreview)).toBe("Preview in docs · Off for the board");
    expect(rowSubline(onlyPreview, undefined).text).toBe("Preview in docs · no runs yet");
    const both = automationReach("a", entry("a", false), [...projects([true, true]), preview("docs")]);
    expect(onInProjectsText(both)).toBe("On in 2 projects · Preview in docs");
  });
});

const off3 = () => automationReach("a", entry("a", false), [{ title: "p", entries: [entry("a", false)] }]);

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

describe("agent fields", () => {
  const fields = [
    { key: "skill", label: "Review skill", kind: "skill" as const },
    { key: "runner", label: "Runner", kind: "select" as const },
    { key: "modelChoice", label: "Model", kind: "model" as const },
    { key: "budgetUsd", label: "Budget", kind: "number" as const },
    { key: "timeoutMinutes", label: "Timeout", kind: "number" as const },
  ];

  it("splits out the model and the fields the board's agent defaults cover", () => {
    const { model, runner, rest } = splitAgentFields(fields);
    expect(model?.key).toBe("modelChoice");
    expect(runner.map((f) => f.key)).toEqual(["runner", "budgetUsd", "timeoutMinutes"]);
    expect(rest.map((f) => f.key)).toEqual(["skill"]);
    expect(advancedFieldNames(fields)).toEqual(["Agent", "Review skill"]);
    expect(advancedFieldNames([fields[0]!])).toEqual(["Review skill"]);
  });

  it("titles the line by the fields it has", () => {
    expect(agentFieldsTitle(splitAgentFields(fields).runner)).toBe("Runner, budget and timeout");
    expect(agentFieldsTitle([{ key: "budgetUsd" }, { key: "timeoutMinutes" }])).toBe("Budget and timeout");
    expect(agentFieldsTitle([{ key: "budgetUsd" }])).toBe("Budget");
  });

  it("summarises the effective values, and T3 access only when it isn't T3's default", () => {
    const keys = [{ key: "runner" }, { key: "budgetUsd" }, { key: "timeoutMinutes" }, { key: "t3Access" }];
    expect(agentSummary(keys, { runner: "auto", budgetUsd: 5, timeoutMinutes: 60, t3Access: "default" })).toBe(
      "Auto · $5 · 60 min",
    );
    expect(agentSummary(keys, { runner: "headless", budgetUsd: 2.5, timeoutMinutes: 20, t3Access: "auto" })).toMatch(
      /^Headless · \$2\.50 · 20 min · T3: /,
    );
  });
});
