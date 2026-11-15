import type { AutopilotMachine } from "@repo/contracts";

// Autopilot on connected machines, as the settings show it (docs/features/remote-machines.md#autopilot-on-the-machine).

/** Whose limits the Limits & safety page edits: this board's, or one connected machine's. */
export type LimitsTarget = "board" | { machineId: string };

/** The machines whose limits can be set: those that run Autopilot (or haven't said yet), in the order listed. */
export function limitMachines(machines: readonly AutopilotMachine[]): AutopilotMachine[] {
  return machines.filter((m) => m.runsAutopilot !== false);
}

/** The target as a select value, and back. */
export const targetValue = (target: LimitsTarget): string => (target === "board" ? "board" : target.machineId);
export const targetOf = (value: string): LimitsTarget => (value === "board" ? "board" : { machineId: value });

/** The machine a target names, when it still exists; null for the board (or a machine since removed). */
export function targetMachine(target: LimitsTarget, machines: readonly AutopilotMachine[]): AutopilotMachine | null {
  if (target === "board") return null;
  return machines.find((m) => m.id === target.machineId) ?? null;
}

/**
 * What the page says above a machine's limits: whose they are, whether they have reached it, and what it ran today.
 * `tone` is `warning` when a change is waiting for a machine that can't be reached now.
 */
export function machineLimitsNote(machine: AutopilotMachine): {
  tone: "info" | "warning";
  text: string;
} {
  const runs =
    `${machine.runsToday} agent run${machine.runsToday === 1 ? "" : "s"} today` +
    (machine.activeRuns > 0 ? `, ${machine.activeRuns} going` : "");
  const whose = machine.ownLimits
    ? `${machine.name} has its own limits.`
    : `${machine.name} goes by this board's limits until you change one here.`;
  if (machine.connection !== "connected") {
    return {
      tone: "warning",
      text: `${machine.name} can't be reached now, so it keeps the limits it last had; changes reach it once it is back. ${runs}.`,
    };
  }
  if (!machine.synced)
    return {
      tone: "warning",
      text: `${whose} Sending the latest to ${machine.name}… ${runs}.`,
    };
  return {
    tone: "info",
    text: `${whose} Its Autopilot counts only its own runs: ${runs}.`,
  };
}

/**
 * The machines Pause all, as it stands, hasn't reached: they still run (or still hold back) their tasks' Autopilot as
 * before. Empty when every machine has it.
 */
export function pauseNotDelivered(machines: readonly AutopilotMachine[]): AutopilotMachine[] {
  // Unknown (not heard from since the board started) isn't said to be behind: it may well have it.
  return limitMachines(machines).filter((m) => m.pauseDelivered === false);
}

/** The sentence beside Pause all for the machines it hasn't reached; null when it has reached them all. */
export function pauseDeliveryText(machines: readonly AutopilotMachine[], paused: boolean): string | null {
  const waiting = pauseNotDelivered(machines);
  if (waiting.length === 0) return null;
  const names = listNames(waiting.map((m) => m.name));
  const verb = waiting.length === 1 ? "hasn't" : "haven't";
  return paused
    ? `${names} ${verb} got Pause all yet, so ${waiting.length === 1 ? "it" : "they"} may still start runs; it reaches ${waiting.length === 1 ? "it" : "them"} once connected.`
    : `${names} ${verb} heard Autopilot resumed yet, so ${waiting.length === 1 ? "it stays" : "they stay"} paused until connected.`;
}

/** "a", "a and b", "a, b and c". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** What a scheduled automation's Runs on row says under its title. */
export function runsOnDescription(
  machineId: string | null,
  machines: readonly AutopilotMachine[],
): { tone: "info" | "warning"; text: string } {
  if (machineId === null) return { tone: "info", text: "This board runs it, while the board is on." };
  const machine = machines.find((m) => m.id === machineId);
  if (!machine)
    return {
      tone: "warning",
      text: "Its machine was removed, so this board runs it.",
    };
  if (machine.runsAutopilot === false) {
    return {
      tone: "warning",
      text: `${machine.name} runs a version from before Autopilot ran on machines, so this board runs it until ${machine.name} is updated.`,
    };
  }
  if (machine.connection !== "connected") {
    return {
      tone: "warning",
      text: `${machine.name} runs it by its own Autopilot. It can't be reached now; it goes on with what it last had.`,
    };
  }
  return {
    tone: "info",
    text: `${machine.name} runs it by its own Autopilot, whether or not this board is on.`,
  };
}
