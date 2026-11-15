import { describe, expect, it } from "vitest";
import { RUN_HERE, resolveRunOn, runOnLocked } from "./runOn.ts";

const known = (id: string) => id === "engine" || id === "mini";

describe("resolveRunOn", () => {
  it("takes the task's own choice first", () => {
    expect(resolveRunOn("mini", "engine", known)).toEqual({ machineId: "mini", source: "task" });
    expect(resolveRunOn(RUN_HERE, "engine", known)).toEqual({ machineId: null, source: "task" });
  });

  it("follows the project's default when the task has none", () => {
    expect(resolveRunOn(null, "engine", known)).toEqual({ machineId: "engine", source: "project" });
    expect(resolveRunOn(undefined, RUN_HERE, known)).toEqual({ machineId: null, source: "project" });
  });

  it("is this machine when neither says", () => {
    expect(resolveRunOn(null, null, known)).toEqual({ machineId: null, source: "board" });
  });

  it("skips a machine the board no longer has", () => {
    expect(resolveRunOn("gone", "engine", known)).toEqual({ machineId: "engine", source: "project" });
    expect(resolveRunOn("gone", "gone too", known)).toEqual({ machineId: null, source: "board" });
  });
});

describe("runOnLocked", () => {
  it("leaves a task in Backlog or Planned open", () => {
    expect(runOnLocked({ status: "backlog" })).toBe(false);
    expect(runOnLocked({ status: "planned", hold: null })).toBe(false);
  });

  it("locks a task once it has started, or while a machine holds it", () => {
    expect(runOnLocked({ status: "in_progress" })).toBe(true);
    expect(runOnLocked({ status: "planned", hold: { machineId: "engine" } })).toBe(true);
  });
});
