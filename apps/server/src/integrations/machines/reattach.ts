import { BOARD_RESTARTED_ERROR, type AutopilotRun } from "@repo/contracts";
import type { ActionResult, RunnerResult } from "../../autopilot/types.ts";
import type { Services } from "../../services/types.ts";
import { messageOf, type Logger } from "../util.ts";
import type { JobEnding, RemoteWork } from "./remoteWork.ts";

// A board's runs that a restart left going on a machine (docs/features/remote-machines.md#after-a-restart): `recover`
// leaves them running, and this reads each one's job again and ends the run by how the job ended.

/** How long the board keeps trying to read a machine's log once a job's end is known, before it judges anyway. */
const CATCH_UP_MS = 15 * 60_000;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 30_000;

export interface Reattacher {
  /** Reads the run's job on the machine until it ends, then ends the run. Never throws. */
  reattach(run: AutopilotRun, machineId: string): Promise<void>;
}

/** What the runner recorded, without the agent's answer. */
const patchOf = ({ result: _result, output: _output, ...patch }: RunnerResult) => patch;

export function createReattacher(deps: {
  services: () => Services;
  work: Pick<RemoteWork, "reattach" | "forgetJob">;
  /** One round of the machine's log: the board's copy of the task catches up with what the agent did there. */
  pump: (machineId: string) => Promise<{ more: boolean; error?: string | null }>;
  /** A run ended: as the engine's own listener, so the session's link shows it at once. */
  runEnded?: (run: AutopilotRun) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
}): Reattacher {
  const log = deps.log ?? console;
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref();
      }));

  /**
   * Reads the machine's log until there is nothing more, tried again while it can't be read. The agent's own moves
   * (out of Planned) reach the board this way, and a job that ended while the board was off must be judged by them.
   */
  const catchUp = async (machineId: string): Promise<void> => {
    const until = now() + CATCH_UP_MS;
    let delay = RETRY_MIN_MS;
    for (;;) {
      try {
        let result = await deps.pump(machineId);
        while (result.more && !result.error) result = await deps.pump(machineId);
        if (!result.error) return;
        throw new Error(result.error);
      } catch (error) {
        if (now() + delay > until) {
          log.warn(`[machines] judging a re-attached run without the machine's latest changes: ${messageOf(error)}`);
          return;
        }
        await sleep(delay);
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      }
    }
  };

  /** The run's ending, given its job's. */
  const judge = (run: AutopilotRun, machineName: string, ending: JobEnding): ActionResult => {
    const s = deps.services();
    const restarted = `${BOARD_RESTARTED_ERROR} while this run was going`;
    switch (ending.kind) {
      case "done": {
        const mode = s.autopilot.automations().find((a) => a.key === run.automation)?.afterRestart ?? "flag";
        if (typeof mode === "function") return mode(ending.result, { services: s, run });
        if (mode === "finish") return patchOf(ending.result);
        return {
          ...patchOf(ending.result),
          status: "failed",
          error: `${restarted}. It finished on ${machineName}, but what it answered wasn't acted on: look at the task`,
          needsAttention: run.taskId !== null,
        };
      }
      case "failed":
        return { status: "failed", error: ending.error, needsAttention: run.taskId !== null };
      case "unreachable":
        return { status: "failed", error: `${restarted}, and ${ending.error}`, needsAttention: run.taskId !== null };
      case "unknown":
      case "never_started":
        // `never_started` is handled before judging; a plain `unknown` comes from a machine that can't say.
        return {
          status: "failed",
          error: `${restarted}. It ran on ${machineName}, where its agent may still be working: look at the task before retrying`,
          needsAttention: run.taskId !== null,
        };
    }
  };

  const ended = (run: AutopilotRun) => {
    try {
      deps.runEnded?.(run);
    } catch (error) {
      log.warn(`[autopilot] run-ended listener failed: ${messageOf(error)}`);
    }
  };

  return {
    async reattach(run, machineId) {
      const s = deps.services();
      let machineName = "the machine";
      try {
        machineName = s.machines.get(machineId).name;
        const ending = await deps.work.reattach(machineId, run.id, (patch) => {
          try {
            s.autopilot.update(run.id, patch);
          } catch (error) {
            log.warn(`[autopilot] couldn't record a re-attached run: ${messageOf(error)}`);
          }
        });
        if (ending.kind === "never_started") {
          ended(s.autopilot.retireUnstarted(run.id));
          return;
        }
        if (ending.kind === "done" || ending.kind === "failed") await catchUp(machineId);
        const result = judge(run, machineName, ending);
        ended(s.autopilot.finish(run.id, result));
        // The board has the outcome: the machine needn't keep it.
        if (ending.kind === "done" || ending.kind === "failed") deps.work.forgetJob(machineId, run.id);
      } catch (error) {
        try {
          ended(
            s.autopilot.finish(run.id, {
              status: "failed",
              error: `${BOARD_RESTARTED_ERROR} while this run was going, and reading it again on ${machineName} failed: ${messageOf(error)}`,
              needsAttention: run.taskId !== null,
            }),
          );
        } catch (finishError) {
          // The run went with its task (deleted meanwhile); nothing is left to record it on.
          log.warn(`[autopilot] couldn't end a re-attached run: ${messageOf(finishError)}`);
        }
      }
    },
  };
}
