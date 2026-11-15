import { resolveRunOn, type ResolvedRunOn } from "@repo/contracts";
import type { Services } from "./types.ts";

// Where a task runs, read in one place on the server (docs/features/remote-machines.md#choosing-the-machine): the
// task's own choice, then its project's default, then this machine. contracts' resolveRunOn is the rule; this reads
// the task, its project and the board's machines for it.

export interface TaskRunsOn extends ResolvedRunOn {
  /** The machine's name; null for this machine. */
  machineName: string | null;
}

export function taskRunsOn(services: Pick<Services, "tasks" | "projects" | "machines">, taskId: string): TaskRunsOn {
  const task = services.tasks.summary(taskId);
  const project = services.projects.get(task.projectId);
  const machines = new Map(services.machines.list().map((m) => [m.id, m.name]));
  const resolved = resolveRunOn(task.runOn, project.runOn, (id) => machines.has(id));
  return { ...resolved, machineName: resolved.machineId ? (machines.get(resolved.machineId) ?? null) : null };
}
