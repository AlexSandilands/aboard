import { z } from "zod";

// Where a task runs (docs/features/remote-machines.md#choosing-the-machine): this machine, or a connected machine
// that the task is handed to when it starts. The task's own choice wins, then its project's default, then this machine.

/** `runOn` for this machine, said outright: a task set to it doesn't follow its project's default. */
export const RUN_HERE = "here";

/** A connected machine's id, or `here`. */
export const RunOn = z.string().trim().min(1).max(200);
export type RunOn = z.infer<typeof RunOn>;

/** `PUT /api/tasks/:id/run-on`: null follows the project's default again. */
export const SetRunOnInput = z.object({ runOn: RunOn.nullable() });
export type SetRunOnInput = z.infer<typeof SetRunOnInput>;

export interface ResolvedRunOn {
  /** The connected machine the task runs on; null for this machine. */
  machineId: string | null;
  /** Whose choice it is: the task's own, its project's default, or nobody's (this machine). */
  source: "task" | "project" | "board";
}

/**
 * Where a task runs: its own choice, else its project's default, else this machine. A machine that is no longer
 * connected to the board (`known` says which are) counts as no choice, so the next one down decides.
 */
export function resolveRunOn(
  taskRunOn: string | null | undefined,
  projectRunOn: string | null | undefined,
  known: (machineId: string) => boolean,
): ResolvedRunOn {
  const pick = (value: string | null | undefined): string | null | undefined => {
    if (!value) return undefined;
    if (value === RUN_HERE) return null;
    return known(value) ? value : undefined;
  };
  const own = pick(taskRunOn);
  if (own !== undefined) return { machineId: own, source: "task" };
  const fromProject = pick(projectRunOn);
  if (fromProject !== undefined) return { machineId: fromProject, source: "project" };
  return { machineId: null, source: "board" };
}

/** A task that has started stays where it started; only one in Backlog or Planned can be pointed elsewhere. */
export function runOnLocked(task: { status: string; hold?: unknown }): boolean {
  return !!task.hold || (task.status !== "backlog" && task.status !== "planned");
}
