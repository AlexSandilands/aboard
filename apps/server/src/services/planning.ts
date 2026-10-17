import { planTaskProblem, type PlanSkillRef, type TaskSummary } from "@repo/contracts";
import { AppError } from "../errors.ts";
import type { Services } from "./types.ts";

// Bulk planning: one session that plans several of a project's tasks with the user. See
// docs/features/agent-handoff.md.

/** Why a task can't be planned in a bulk session, or null when it can. */
export function planningProblem(task: TaskSummary, projectId: string): string | null {
  return task.projectId === projectId ? planTaskProblem(task) : `#${task.number} is in another project`;
}

/**
 * The tasks of `projectId` that `refs` name (`#N` or ids), in the order given and without repeats. Throws when one
 * can't be planned here, so a session never starts on a half-valid list.
 */
export function tasksToPlan(
  services: Pick<Services, "tasks">,
  projectId: string,
  refs: readonly string[],
): TaskSummary[] {
  const ids = [...new Set(refs.map((ref) => services.tasks.resolveId(ref)))];
  const tasks = ids.map((id) => services.tasks.summary(id));
  const problems = tasks.map((task) => planningProblem(task, projectId)).filter((p): p is string => p !== null);
  if (problems.length > 0) throw new AppError("VALIDATION", `Can't plan these tasks: ${problems.join("; ")}`);
  return tasks;
}

/** The skill a project's planning sessions follow: its own, else the board's. */
export const planSkillFor = (services: Pick<Services, "projects" | "settings">, projectId: string): PlanSkillRef =>
  services.projects.get(projectId).planSkill ?? services.settings.get().planSkill;
