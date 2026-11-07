import { describe, expect, it } from "vitest";
import {
  autopilotRunEventText,
  autopilotSessionName,
  canRetryRun,
  describeInherited,
  inQuietHours,
  isAutopilotSessionName,
  isSupersededRun,
  resolveAutopilot,
  unretiredKey,
  type AutopilotRun,
} from "./autopilot.ts";

type Mode = "inherit" | "on" | "preview" | "off";
const board = (mode: Mode, config = {}) => ({ scopeKind: "board" as const, mode, config });
const project = (mode: Mode, config = {}) => ({ scopeKind: "project" as const, mode, config });
const epic = (mode: Mode, config = {}) => ({ scopeKind: "epic" as const, mode, config });

describe("resolveAutopilot", () => {
  it("is off by default", () => {
    expect(resolveAutopilot([])).toEqual({ enabled: false, preview: false, source: "default", config: {} });
    expect(resolveAutopilot([undefined, null])).toEqual({
      enabled: false,
      preview: false,
      source: "default",
      config: {},
    });
    expect(resolveAutopilot([board("inherit"), project("inherit")])).toMatchObject({
      enabled: false,
      source: "default",
    });
  });

  it("lets the most specific scope that isn't inherit win", () => {
    expect(resolveAutopilot([board("on"), undefined])).toMatchObject({ enabled: true, source: "board" });
    expect(resolveAutopilot([board("on"), project("inherit")])).toMatchObject({ enabled: true, source: "board" });
    expect(resolveAutopilot([board("on"), project("off")])).toMatchObject({ enabled: false, source: "project" });
    expect(resolveAutopilot([board("off"), project("on")])).toMatchObject({ enabled: true, source: "project" });
    expect(resolveAutopilot([undefined, project("on")])).toMatchObject({ enabled: true, source: "project" });
  });

  it("resolves Preview as enabled with preview set, at whichever scope wins", () => {
    expect(resolveAutopilot([board("preview")])).toEqual({ enabled: true, preview: true, source: "board", config: {} });
    expect(resolveAutopilot([board("preview"), project("on")])).toMatchObject({ enabled: true, preview: false });
    expect(resolveAutopilot([board("on"), project("preview")])).toMatchObject({
      enabled: true,
      preview: true,
      source: "project",
    });
    expect(resolveAutopilot([board("on"), project("inherit"), epic("preview")])).toMatchObject({
      preview: true,
      source: "epic",
    });
    expect(resolveAutopilot([board("preview"), project("off")])).toMatchObject({ enabled: false, preview: false });
    expect(describeInherited({ enabled: true, preview: true, source: "board" })).toBe("Inherit (Preview from board)");
  });

  it("merges config keys board first, whatever the modes", () => {
    const resolved = resolveAutopilot([board("on", { days: 7, skill: "a" }), project("inherit", { days: 3 })]);
    expect(resolved.config).toEqual({ days: 3, skill: "a" });
  });

  it("labels an inherit switch by what it resolves to", () => {
    expect(describeInherited({ enabled: true, source: "board" })).toBe("Inherit (On from board)");
    expect(describeInherited({ enabled: false, source: "default" })).toBe("Inherit (Off by default)");
  });
});

describe("inQuietHours", () => {
  const at = (h: number, m = 0) => h * 60 + m;

  it("is never quiet while off, or with equal ends", () => {
    expect(inQuietHours({ enabled: false, start: "00:00", end: "23:59" }, at(12))).toBe(false);
    expect(inQuietHours({ enabled: true, start: "09:00", end: "09:00" }, at(9))).toBe(false);
  });

  it("covers a same-day window, start inclusive and end exclusive", () => {
    const quiet = { enabled: true, start: "09:00", end: "17:30" };
    expect(inQuietHours(quiet, at(8, 59))).toBe(false);
    expect(inQuietHours(quiet, at(9))).toBe(true);
    expect(inQuietHours(quiet, at(17, 29))).toBe(true);
    expect(inQuietHours(quiet, at(17, 30))).toBe(false);
  });

  it("wraps past midnight", () => {
    const quiet = { enabled: true, start: "22:00", end: "07:00" };
    expect(inQuietHours(quiet, at(23))).toBe(true);
    expect(inQuietHours(quiet, at(3))).toBe(true);
    expect(inQuietHours(quiet, at(7))).toBe(false);
    expect(inQuietHours(quiet, at(12))).toBe(false);
  });
});

describe("autopilotRunEventText", () => {
  it("describes each run status", () => {
    const base = { title: "Archive", summary: "archive #4" };
    expect(autopilotRunEventText({ ...base, status: "running" })).toBe("started Archive: archive #4");
    expect(autopilotRunEventText({ ...base, status: "succeeded" })).toBe("finished Archive: archive #4");
    expect(autopilotRunEventText({ ...base, status: "failed", error: "boom" })).toBe("Archive failed: boom");
    expect(autopilotRunEventText({ ...base, status: "dismissed" })).toBe("dismissed the Archive flag: archive #4");
    expect(autopilotRunEventText({ ...base, status: "skipped", summary: "Would archive #4", dryRun: true })).toBe(
      "Archive (dry run): Would archive #4",
    );
    expect(autopilotRunEventText({ ...base, status: "retried" })).toBe("asked Archive to try again: archive #4");
    expect(autopilotRunEventText({ ...base, status: "retried", reason: "restart" })).toBe(
      "Archive will try again, since the board restarted while it was going: archive #4",
    );
  });
});

describe("unretiredKey", () => {
  it("gives back the key a retired one had, and leaves other keys alone", () => {
    expect(unretiredKey("retried:6f1c-2:review:pr:l1:abc")).toBe("review:pr:l1:abc");
    expect(unretiredKey("review:pr:l1:abc")).toBe("review:pr:l1:abc");
  });
});

describe("Autopilot session names", () => {
  it("names a session by its run's label, else plainly", () => {
    expect(autopilotSessionName("Review #7")).toBe("Autopilot · Review #7");
    expect(autopilotSessionName("  ")).toBe("Autopilot session");
    expect(autopilotSessionName(undefined)).toBe("Autopilot session");
  });

  it("puts the task first when the run has one, and cuts a long title but never the automation", () => {
    const task = { number: 72, title: "Better title for autopilot started tasks" };
    expect(autopilotSessionName("Start planned", task)).toBe(
      "#72 Better title for autopilot started tasks · Autopilot: Start planned",
    );
    expect(autopilotSessionName("Fix PRs · PR #73", task)).toBe(
      "#72 Better title for autopilot started tasks · Autopilot: Fix PRs · PR #73",
    );
    expect(autopilotSessionName(undefined, task)).toBe("#72 Better title for autopilot started tasks · Autopilot");
    const long = autopilotSessionName("Review PRs", { number: 5, title: "x".repeat(100) });
    expect(long).toBe(`#5 ${"x".repeat(59)}… · Autopilot: Review PRs`);
    expect(autopilotSessionName("Review PRs", { number: 5, title: `${"x".repeat(58)}😀😀😀` })).toBe(
      `#5 ${"x".repeat(58)}😀… · Autopilot: Review PRs`,
    );
    expect(autopilotSessionName("Review PRs", null)).toBe("Autopilot · Review PRs");
  });

  it("recognises the names it makes, and nothing a person would give a session", () => {
    const task = { number: 7, title: "Add a cart" };
    expect(isAutopilotSessionName(autopilotSessionName("Review #7", task))).toBe(true);
    expect(isAutopilotSessionName(autopilotSessionName(undefined, task))).toBe(true);
    expect(isAutopilotSessionName("#7 Add a cart")).toBe(false);
    expect(isAutopilotSessionName("Review · Autopilot")).toBe(false);
    expect(isAutopilotSessionName(autopilotSessionName("Review #7"))).toBe(true);
    expect(isAutopilotSessionName(autopilotSessionName(undefined))).toBe(true);
    expect(isAutopilotSessionName("Implementing the cart")).toBe(false);
    expect(isAutopilotSessionName("Autopilot notes")).toBe(false);
    expect(isAutopilotSessionName(null)).toBe(false);
  });
});

describe("canRetryRun", () => {
  const run = (id: string, at: string, extra: Partial<AutopilotRun> = {}) =>
    ({
      id,
      automation: "review_prs",
      taskId: "t1",
      projectId: "p1",
      createdAt: at,
      dryRun: false,
      status: "failed",
      dedupeKey: `k:${id}`,
      ...extra,
    }) as AutopilotRun;

  it("retries a real failed or skipped run that nothing has superseded", () => {
    const failed = run("a", "2026-10-18T01:00:00.000Z");
    expect(canRetryRun(failed)).toBe(true);
    expect(canRetryRun({ ...failed, status: "succeeded" })).toBe(false);
    expect(canRetryRun({ ...failed, dryRun: true })).toBe(false);
    expect(canRetryRun({ ...failed, dedupeKey: "retried:a:k" })).toBe(false);
  });

  it("refuses a run the same automation has made a real run on the task since", () => {
    const failed = run("a", "2026-10-18T01:00:00.000Z");
    const later = run("b", "2026-10-18T02:00:00.000Z", { status: "succeeded" });
    expect(canRetryRun(failed, [later, failed])).toBe(false);
    expect(canRetryRun(failed, [{ ...later, dryRun: true }])).toBe(true);
    expect(canRetryRun(failed, [{ ...later, automation: "fix_prs" }])).toBe(true);
    expect(canRetryRun(failed, [{ ...later, taskId: "t2" }])).toBe(true);
    expect(isSupersededRun(later, [failed])).toBe(false);
  });

  it("goes by the list's order when two runs were made in the same millisecond", () => {
    const at = "2026-10-18T01:00:00.000Z";
    const failed = run("a", at);
    const later = run("b", at, { status: "succeeded" });
    expect(canRetryRun(failed, [later, failed])).toBe(false);
    expect(isSupersededRun(later, [later, failed])).toBe(false);
  });
});
