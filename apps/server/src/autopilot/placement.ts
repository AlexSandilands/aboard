import {
  AUTOPILOT_FIX_PRS,
  AUTOPILOT_MERGE_EPIC_PRS,
  AUTOPILOT_REVIEW_PRS,
  AUTOPILOT_START_PLANNED,
  customAutomationId,
  type CustomAutomation,
} from "@repo/contracts";
import type { Services } from "../services/types.ts";
import type { Automation, Candidate } from "./types.ts";

// Which server's Autopilot acts on what (docs/features/remote-machines.md#autopilot-on-the-machine). A machine that
// runs Autopilot itself does so for the tasks it holds and the scheduled automations pinned to it; the board does
// everything else. Each candidate has exactly one server that acts on it, so nothing runs twice.

/**
 * The built-in automations a runner runs over the tasks it holds: the ones that carry a task from Planned to merged.
 * The rest are about the board (its lanes, digests, recurring tasks, other people's PRs) and stay there.
 */
export const RUNNER_AUTOMATIONS: ReadonlySet<string> = new Set([
  AUTOPILOT_START_PLANNED,
  AUTOPILOT_REVIEW_PRS,
  AUTOPILOT_FIX_PRS,
  AUTOPILOT_MERGE_EPIC_PRS,
]);

/** Decides, for one server's engine, which automations it runs and which of their candidates are its own. */
export interface Placement {
  runsHere(automation: Automation): boolean;
  owns(candidate: Candidate, automation: Automation): boolean;
}

const customOf = (s: Services, key: string): CustomAutomation | null => {
  const id = customAutomationId(key);
  if (!id) return null;
  try {
    return s.customAutomations.get(id);
  } catch {
    return null;
  }
};

/**
 * A board's: everything, except the tasks held by a machine that runs Autopilot itself and the scheduled automations
 * pinned to a machine. `runsAutopilot` says whether a machine does: false for a runner from before it (the board then
 * sends that machine its runs, as it did), null while unknown, which counts as yes.
 */
export function boardPlacement(
  services: () => Services,
  runsAutopilot: (machineId: string) => boolean | null,
): Placement {
  return {
    runsHere: () => true,
    owns(candidate, automation) {
      const s = services();
      if (candidate.taskId) {
        const hold = s.holds.get(candidate.taskId);
        return !hold || runsAutopilot(hold.machineId) === false;
      }
      const pinned = customOf(s, automation.key)?.machineId;
      // Pinned to a machine the board no longer has, or one that doesn't run Autopilot (a runner from before it): it
      // runs here, rather than nowhere.
      return !pinned || !s.machines.list().some((m) => m.id === pinned) || runsAutopilot(pinned) === false;
    },
  };
}

/** A runner's: the board's task automations over the tasks it holds, and the scheduled automations pinned to it. */
export function runnerPlacement(services: () => Services, instanceId: string): Placement {
  return {
    runsHere(automation) {
      if (RUNNER_AUTOMATIONS.has(automation.key)) return true;
      const custom = customOf(services(), automation.key);
      if (!custom) return false;
      return custom.trigger.kind !== "schedule" || custom.machineId === instanceId;
    },
    owns(candidate, automation) {
      const s = services();
      if (candidate.taskId) return s.workingCopies.role(candidate.taskId) === "held";
      return customOf(s, automation.key)?.machineId === instanceId;
    },
  };
}
