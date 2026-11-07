import type { ModelChoice } from "@repo/contracts";

/**
 * What Autopilot may do on a task: start it (Start planned tasks), review it (a local review round when it moves to
 * Review) and merge it (merge_task_pr). Each is one chip in the panel's Autopilot section.
 */
export type MayFlag = "start" | "review" | "merge";

export const MAY_FLAGS: ReadonlyArray<{ flag: MayFlag; label: string; hint: string }> = [
  { flag: "start", label: "start it", hint: "Start planned tasks may start this task once it is planned" },
  { flag: "review", label: "review it", hint: "Open a local review round when the task moves to Review" },
  { flag: "merge", label: "merge it", hint: "An agent may merge this task's pull request with merge_task_pr" },
];

/**
 * Which chips are on. Start and merge are on only when the task says so: their Default never acts, so it reads as off.
 * Review follows the board's Auto-review setting while the task doesn't say.
 */
export function mayState(
  task: { autopilot: boolean | null; autoReview: boolean | null; autoMerge: boolean | null },
  globalReview: boolean,
): Record<MayFlag, boolean> {
  return { start: task.autopilot === true, review: task.autoReview ?? globalReview, merge: task.autoMerge === true };
}

/** The update a change in the Autopilot section sends, so each control writes its own field. */
export type AutomationChange =
  | { setting: "may"; flag: MayFlag; on: boolean }
  | { setting: "reviewModel"; model: ModelChoice | null }
  | { setting: "priority"; on: boolean }
  | { setting: "manual"; on: boolean };

function mayUpdate(flag: MayFlag, on: boolean, globalReview: boolean) {
  switch (flag) {
    case "start":
      return { autopilot: on ? true : null };
    case "merge":
      return { autoMerge: on ? true : null };
    case "review":
      return { autoReview: on === globalReview ? null : on };
  }
}

/**
 * The task fields a change writes. The data keeps its Default / On / Off, but the chips show only on and off: turning
 * one off goes back to Default (null), which acts the same as Off for start and merge and follows the board for
 * review. Review is stored as an explicit choice only when it differs from the board's setting.
 */
export function automationUpdate(
  change: AutomationChange,
  globalReview: boolean,
):
  | { autopilot: boolean | null }
  | { autoMerge: boolean | null }
  | { autoReview: boolean | null }
  | { reviewModel: ModelChoice | null }
  | { priority: boolean }
  | { manual: boolean } {
  switch (change.setting) {
    case "may":
      return mayUpdate(change.flag, change.on, globalReview);
    case "reviewModel":
      return { reviewModel: change.model };
    case "priority":
      return { priority: change.on };
    case "manual":
      return { manual: change.on };
  }
}
