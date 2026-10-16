import { describe, expect, it } from "vitest";
import { autopilotRunEventText, describeInherited, inQuietHours, resolveAutopilot } from "./autopilot.ts";

const board = (mode: "inherit" | "on" | "off", config = {}) => ({ scopeKind: "board" as const, mode, config });
const project = (mode: "inherit" | "on" | "off", config = {}) => ({ scopeKind: "project" as const, mode, config });

describe("resolveAutopilot", () => {
  it("is off by default", () => {
    expect(resolveAutopilot([])).toEqual({ enabled: false, source: "default", config: {} });
    expect(resolveAutopilot([undefined, null])).toEqual({ enabled: false, source: "default", config: {} });
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
    expect(autopilotRunEventText({ ...base, status: "skipped", summary: "Would archive #4", dryRun: true })).toBe(
      "Archive (dry run): Would archive #4",
    );
  });
});
