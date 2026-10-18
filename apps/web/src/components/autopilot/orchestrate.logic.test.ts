import { AUTOPILOT_ORCHESTRATE, type AutopilotRun, type AutopilotScopeEntry } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  formatCountdown,
  formatPillCountdown,
  lastRunText,
  orchestrateLine,
  pillTimerAt,
  projectHasOrchestrateWork,
} from "./orchestrate.logic";

const MINUTE = 60_000;
const quiet = { quietHours: { enabled: true, start: "22:00", end: "07:00" } };

const entry = (enabled: boolean, everyMinutes = 30): AutopilotScopeEntry => ({
  automation: AUTOPILOT_ORCHESTRATE,
  mode: enabled ? "on" : "off",
  config: {},
  enabled,
  source: "project",
  effectiveConfig: { everyMinutes },
});

const state = (patch: Partial<Parameters<typeof orchestrateLine>[0]> = {}) => ({
  enabled: true,
  everyMinutes: 30,
  hold: null,
  running: false,
  requestedAt: null,
  ...patch,
});

describe("formatCountdown", () => {
  it("shows minutes and seconds, hours from an hour up, never below zero", () => {
    expect(formatCountdown(12 * MINUTE + 34_000)).toBe("12:34");
    expect(formatCountdown(59_500)).toBe("1:00");
    expect(formatCountdown(3_723_000)).toBe("1:02:03");
    expect(formatCountdown(-5_000)).toBe("0:00");
  });

  it("rounds the pill's minutes up so it never reads 0m before the slot", () => {
    expect(formatPillCountdown(30_000)).toBe("<1m");
    expect(formatPillCountdown(11 * MINUTE + 1_000)).toBe("12m");
    expect(formatPillCountdown(120 * MINUTE)).toBe("2h");
    expect(formatPillCountdown(65 * MINUTE)).toBe("1h 5m");
  });
});

describe("orchestrateLine", () => {
  const now = new Date(2026, 9, 17, 13, 44, 30);

  it("counts down to the next slot from everyMinutes", () => {
    const line = orchestrateLine(state({ everyMinutes: 15 }), quiet, now);
    expect(line).toMatchObject({ kind: "countdown", text: "Next check in 0:30" });
    expect(line.kind === "countdown" && line.nextAt).toEqual(new Date(2026, 9, 17, 13, 45));
  });

  it("says why no check is coming instead of counting down", () => {
    expect(orchestrateLine(state({ hold: "idle" }), quiet, now).text).toBe("Idle: nothing to check");
    expect(orchestrateLine(state({ hold: "paused" }), quiet, now).text).toContain("Paused");
    expect(orchestrateLine(state({ hold: "quiet_hours" }), quiet, now).text).toBe("Quiet hours: no checks until 07:00");
    expect(orchestrateLine(state({ hold: "daily_cap" }), quiet, now).text).toContain("until tomorrow");
    expect(orchestrateLine(state({ enabled: false, hold: "off" }), quiet, now).text).toBe("Off in this project");
  });

  it("puts a run going or asked for first", () => {
    expect(orchestrateLine(state({ hold: "idle", running: true }), quiet, now).kind).toBe("running");
    expect(orchestrateLine(state({ hold: "idle", requestedAt: now.toISOString() }), quiet, now).kind).toBe("requested");
    expect(orchestrateLine(state({ hold: "paused", requestedAt: now.toISOString() }), quiet, now).text).toContain(
      "Paused",
    );
  });
});

describe("lastRunText", () => {
  const run = (patch: Partial<AutopilotRun>) =>
    ({ status: "succeeded", dryRun: false, createdAt: new Date().toISOString(), ...patch }) as AutopilotRun;

  it("says when it last ran and how it went", () => {
    expect(lastRunText(null)).toBe("No runs yet");
    const finishedAt = new Date(Date.now() - 17 * MINUTE).toISOString();
    expect(lastRunText(run({ finishedAt }))).toBe("Last ran 17m ago · Done");
    expect(lastRunText(run({ status: "failed", finishedAt }))).toBe("Last ran 17m ago · Failed");
    expect(lastRunText(run({ status: "running", startedAt: new Date().toISOString(), finishedAt: null }))).toBe(
      "Started just now",
    );
  });
});

describe("pillTimerAt", () => {
  const now = new Date(2026, 9, 17, 13, 44);
  const base = { entries: [entry(true)], paused: false, running: false, engine: quiet, hasWork: true, now };

  it("is the next slot while Orchestrate is on and has work to look at", () => {
    expect(pillTimerAt(base)).toEqual(new Date(2026, 9, 17, 14, 0));
    expect(pillTimerAt({ ...base, entries: [entry(true, 5)] })).toEqual(new Date(2026, 9, 17, 13, 45));
  });

  it("shows no timer when off, paused, running, idle or in quiet hours at the slot", () => {
    expect(pillTimerAt({ ...base, entries: [entry(false)] })).toBeNull();
    expect(pillTimerAt({ ...base, entries: undefined })).toBeNull();
    expect(pillTimerAt({ ...base, paused: true })).toBeNull();
    expect(pillTimerAt({ ...base, running: true })).toBeNull();
    expect(pillTimerAt({ ...base, hasWork: false })).toBeNull();
    expect(pillTimerAt({ ...base, now: new Date(2026, 9, 17, 21, 50) })).toBeNull();
  });

  it("finds work the way the server does", () => {
    const task = {
      projectId: "p",
      archivedAt: null,
      status: "in_progress" as const,
      attention: [],
      autoMerge: null,
      manual: false,
    };
    expect(projectHasOrchestrateWork([task], "p")).toBe(true);
    expect(projectHasOrchestrateWork([task], "other")).toBe(false);
    expect(projectHasOrchestrateWork([{ ...task, status: "review" }], "p")).toBe(false);
    expect(projectHasOrchestrateWork([{ ...task, status: "review", autoMerge: true }], "p")).toBe(true);
    expect(projectHasOrchestrateWork([{ ...task, manual: true }], "p")).toBe(false);
  });
});
