import type { AutopilotMachine } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  limitMachines,
  listNames,
  machineLimitsNote,
  pauseDeliveryText,
  runsOnDescription,
  targetMachine,
  targetOf,
  targetValue,
} from "./machines.logic";

const machine = (over: Partial<AutopilotMachine> = {}): AutopilotMachine => ({
  id: "m1",
  name: "engine",
  connection: "connected",
  runsAutopilot: true,
  limits: {
    maxConcurrent: 1,
    dailyRunCap: null,
    dailySpendCapUsd: null,
    quietHours: { enabled: false, start: "22:00", end: "07:00" },
  },
  ownLimits: false,
  synced: true,
  pauseDelivered: true,
  activeRuns: 0,
  runsToday: 2,
  ...over,
});

describe("limits target", () => {
  it("round-trips through the select's value and finds its machine", () => {
    expect(targetOf(targetValue("board"))).toBe("board");
    expect(targetOf(targetValue({ machineId: "m1" }))).toEqual({
      machineId: "m1",
    });
    expect(targetMachine({ machineId: "m1" }, [machine()])?.name).toBe("engine");
    expect(targetMachine({ machineId: "gone" }, [machine()])).toBeNull();
  });

  it("leaves out machines from before Autopilot ran there", () => {
    expect(
      limitMachines([
        machine(),
        machine({ id: "old", runsAutopilot: false }),
        machine({ id: "new", runsAutopilot: null }),
      ]).map((m) => m.id),
    ).toEqual(["m1", "new"]);
  });
});

describe("machineLimitsNote", () => {
  it("says whose limits they are and what ran today", () => {
    expect(machineLimitsNote(machine())).toEqual({
      tone: "info",
      text: "engine goes by this board's limits until you change one here. Its Autopilot counts only its own runs: 2 agent runs today.",
    });
    expect(machineLimitsNote(machine({ ownLimits: true, activeRuns: 1, runsToday: 1 })).text).toBe(
      "engine has its own limits. Its Autopilot counts only its own runs: 1 agent run today, 1 going.",
    );
  });

  it("warns that a change waits for a machine that can't be reached", () => {
    expect(machineLimitsNote(machine({ connection: "unreachable" }))).toMatchObject({ tone: "warning" });
    expect(machineLimitsNote(machine({ connection: "unreachable" })).text).toContain("can't be reached now");
    expect(machineLimitsNote(machine({ synced: false })).text).toContain("Sending the latest to engine");
  });
});

describe("pauseDeliveryText", () => {
  it("is null once every machine has it", () => {
    expect(pauseDeliveryText([machine()], true)).toBeNull();
  });

  it("names the machines Pause all or Resume hasn't reached", () => {
    const waiting = [machine({ pauseDelivered: false }), machine({ id: "m2", name: "laptop", pauseDelivered: false })];
    expect(pauseDeliveryText(waiting, true)).toBe(
      "engine and laptop haven't got Pause all yet, so they may still start runs; it reaches them once connected.",
    );
    expect(pauseDeliveryText(waiting.slice(0, 1), false)).toBe(
      "engine hasn't heard Autopilot resumed yet, so it stays paused until connected.",
    );
  });

  it("ignores machines that don't run Autopilot", () => {
    expect(pauseDeliveryText([machine({ runsAutopilot: false, pauseDelivered: false })], true)).toBeNull();
  });
});

describe("listNames", () => {
  it("joins names in a sentence", () => {
    expect(listNames(["a"])).toBe("a");
    expect(listNames(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("runsOnDescription", () => {
  it("says which machine runs a scheduled automation", () => {
    expect(runsOnDescription(null, [machine()]).text).toBe("This board runs it, while the board is on.");
    expect(runsOnDescription("m1", [machine()]).text).toBe(
      "engine runs it by its own Autopilot, whether or not this board is on.",
    );
    expect(runsOnDescription("m1", [machine({ connection: "unreachable" })]).tone).toBe("warning");
    expect(runsOnDescription("gone", [machine()]).text).toBe("Its machine was removed, so this board runs it.");
    expect(runsOnDescription("m1", [machine({ runsAutopilot: false })]).text).toContain("so this board runs it until");
  });
});
