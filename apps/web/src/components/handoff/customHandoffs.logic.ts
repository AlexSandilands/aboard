import { handoffTargetHarness, handoffTargetLabel, type StartCustomHandoffResult } from "@repo/contracts";

// What the board says after a custom hand-off started without its dialog. See docs/features/agent-handoff.md#custom-hand-offs.

/** "in a new worktree from origin/main", "in the task's worktree on task/164", "in the project's checkout". */
export function handoffWhere(result: Pick<StartCustomHandoffResult, "workspace" | "branch" | "target">): string {
  if (result.workspace === "current") return "in the project's checkout";
  if (result.workspace === "task_worktree") {
    return `in the task's worktree${result.branch ? ` on ${result.branch}` : ""}`;
  }
  // T3 names the base it branched from; a CLI session's branch is the new worktree's own.
  const from = handoffTargetHarness(result.target) ? "on" : "from";
  return `in a new worktree${result.branch ? ` ${from} ${result.branch}` : ""}`;
}

/** The title of the toast for a hand-off that started: a fallback to a new worktree is said up front. */
export const startedHandoffTitle = (result: Pick<StartCustomHandoffResult, "name" | "fellBack">): string =>
  `Started “${result.name}”${result.fellBack ? " in a new worktree" : ""}`;

/** Why it isn't in the task's worktree, and why it isn't on the hand-off's model, when either is so. */
export function startedHandoffNotes(
  result: Pick<StartCustomHandoffResult, "fellBack" | "note">,
  taskNumber: number,
): string[] {
  return [
    ...(result.fellBack ? [`#${taskNumber} had no worktree yet, so one was made.`] : []),
    ...(result.note ? [result.note] : []),
  ];
}

/**
 * The toast for a T3 Code thread a hand-off started: what started on which model and where, that it is linked, and
 * anything that didn't go as the hand-off asked.
 */
export function startedThreadDescription(result: StartCustomHandoffResult, taskNumber: number): string {
  const model = result.model ? ` on ${result.model}` : "";
  return [
    `${handoffTargetLabel(result.target)}${model} ${handoffWhere(result)}. Linked to #${taskNumber}.`,
    ...startedHandoffNotes(result, taskNumber),
  ].join(" ");
}
