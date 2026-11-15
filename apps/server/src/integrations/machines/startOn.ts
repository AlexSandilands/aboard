import { AUTOPILOT_START_PLANNED } from "@repo/contracts";
import type { RunnerRequest } from "../../autopilot/types.ts";
import { taskRunsOn } from "../../services/runOn.ts";
import type { Services } from "../../services/types.ts";
import type { MachineSync } from "./sync.ts";

// A task set to run on a connected machine goes there when it starts (docs/features/remote-machines.md#choosing-the-machine).
// Starting is Autopilot's Start planned run: until threads and sessions can start on a machine, that is the one way
// work begins somewhere else. Every later run for the task follows the hold.

/** Who hands the task over, in its activity. */
export const START_ACTOR = "autopilot";

/**
 * Hands the run's task to the machine it is set to run on, before the run starts, when this run starts the task
 * and no machine holds it yet. Throws what the hand-over throws (the machine can't be reached, can't clone the
 * repository), so the run fails with that reason and nothing starts here instead.
 */
export async function handOverAtStart(
  services: Services,
  sync: Pick<MachineSync, "handOver">,
  request: Pick<RunnerRequest, "run">,
): Promise<void> {
  const { run } = request;
  if (run.automation !== AUTOPILOT_START_PLANNED || !run.taskId || run.dryRun) return;
  if (services.holds.get(run.taskId)) return;
  const where = taskRunsOn(services, run.taskId);
  if (!where.machineId) return;
  await sync.handOver(run.taskId, where.machineId, START_ACTOR);
}
