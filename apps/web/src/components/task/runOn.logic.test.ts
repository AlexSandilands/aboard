import type { Machine, TaskHold } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { canChooseRunOn, heldLabel, placementOf, placementTitle, runOnOptions, type Placement } from "./runOn.logic";

const machine = (id: string, connection: Machine["connection"] = "connected") => ({
  id,
  name: id,
  prefix: id.slice(0, 1).toUpperCase(),
  connection,
  lastSeenAt: null,
});
const engine = machine("engine");
const studio = machine("studio", "unreachable");
const machines = [engine, studio];
const project = { workspaceRoot: "/work/app", runOn: null };
const task = (patch: Partial<Parameters<typeof placementOf>[0]> = {}) => ({
  kind: "task" as const,
  manual: false,
  archivedAt: null,
  status: "planned" as const,
  runOn: null,
  hold: null,
  ...patch,
});
const hold = (waiting: number, machineId = "engine"): TaskHold => ({
  machineId,
  machineName: machineId,
  since: "2026-11-15T10:00:00.000Z",
  waiting,
});

describe("placementOf", () => {
  it("is here unless the task, then its project, names a machine", () => {
    expect(placementOf(task(), project, machines)).toEqual({ state: "here" });
    expect(placementOf(task({ runOn: "engine" }), project, machines)).toEqual({ state: "will", machine: engine });
    expect(placementOf(task(), { ...project, runOn: "engine" }, machines)).toEqual({ state: "will", machine: engine });
    expect(placementOf(task({ runOn: "here" }), { ...project, runOn: "engine" }, machines)).toEqual({ state: "here" });
  });

  it("stays here once the task started here, whatever it was set to", () => {
    expect(placementOf(task({ status: "in_progress", runOn: "engine" }), project, machines)).toEqual({ state: "here" });
  });

  it("says which machine holds the task, with its waiting edits and whether it can be reached", () => {
    expect(placementOf(task({ status: "in_progress", hold: hold(2) }), project, machines)).toMatchObject({
      state: "held",
      machineName: "engine",
      waiting: 2,
      offline: false,
    });
    expect(placementOf(task({ hold: hold(0, "studio") }), project, machines)).toMatchObject({ offline: true });
  });
});

describe("the chip's words", () => {
  const held = (waiting: number, offline = false) =>
    ({ state: "held", machineId: "engine", machineName: "engine", machine: engine, waiting, offline }) as Extract<
      Placement,
      { state: "held" }
    >;

  it("says where the task is, how many edits wait, and that a machine is offline", () => {
    expect(heldLabel(held(0))).toBe("On engine");
    expect(heldLabel(held(2))).toBe("On engine · 2 waiting");
    expect(heldLabel(held(2, true))).toBe("engine · offline");
  });

  it("explains the waiting edits in the hover", () => {
    expect(placementTitle(held(1))).toContain("1 change made here is waiting for it");
    expect(placementTitle(held(3))).toContain("3 changes made here are waiting for it");
    expect(placementTitle({ state: "here" })).toBeNull();
  });
});

describe("choosing the machine", () => {
  it("is offered for a code task that hasn't started, in a project with a folder, once a machine is connected", () => {
    expect(canChooseRunOn(task(), project, machines)).toBe(true);
    expect(canChooseRunOn(task(), project, [])).toBe(false);
    expect(canChooseRunOn(task(), { workspaceRoot: null, runOn: null }, machines)).toBe(false);
    expect(canChooseRunOn(task({ kind: "epic" }), project, machines)).toBe(false);
    expect(canChooseRunOn(task({ manual: true }), project, machines)).toBe(false);
    expect(canChooseRunOn(task({ status: "review" }), project, machines)).toBe(false);
  });

  it("lists the project's default, this machine, then each machine, off where it can't be reached", () => {
    expect(runOnOptions({ ...project, runOn: "engine" }, machines)).toMatchObject([
      { value: null, label: "Project default", detail: "engine", disabled: false },
      { value: "here", label: "This machine", disabled: false },
      { value: "engine", detail: "Connected", disabled: false },
      { value: "studio", detail: "Can't be reached", disabled: true },
    ]);
  });
});
