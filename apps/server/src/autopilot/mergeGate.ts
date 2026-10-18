import {
  AUTOPILOT_ACTIVE_STATUSES,
  AUTOPILOT_FIX_PRS,
  AUTOPILOT_REVIEW_PRS,
  currentPrReview,
  reviewIsInProgress,
  type AutopilotRun,
  type PrChanges,
  type PrRef,
  type TaskLink,
  type TaskSummary,
} from "@repo/contracts";
import type { Services } from "../services/types.ts";

// The gate every board-made merge passes: Autopilot's into an epic's branch (automations/mergeEpicPrs.ts) and
// merge_task_pr's into the default branch (mcp/tools/merge.ts).

export type PrLink = Extract<TaskLink, { kind: "pr" }> & { ref: PrRef };

/**
 * How long a head must have gone without any check reporting before "no checks" counts as green. GitHub reports none
 * for the first moments after a push, before the workflows register.
 */
export const NO_CHECKS_WAIT_MS = 10 * 60_000;

export const isPrLink = (link: TaskLink): link is PrLink => link.kind === "pr" && link.ref !== null;

/** When the board first saw the PR at its current head: the head's move, else the link's creation. */
export const headSeenSince = (link: PrLink, changes: PrChanges | undefined): number =>
  Date.parse(changes?.newHead ?? link.createdAt);

const reviewPrsOn = (services: Services, task: TaskSummary): boolean => {
  const automation = services.autopilot.automations().find((a) => a.key === AUTOPILOT_REVIEW_PRS);
  return (
    automation !== undefined && services.autopilot.resolve(automation, task.projectId, task.parent?.id ?? null).enabled
  );
};

/**
 * Why a task's PR can't be merged into `branch` yet, or null when it can. The same rules decide the candidates and
 * re-check them before the merge:
 * - the task is In Review and its PR is open (not a draft), into the branch, at a known head;
 * - its local review loop is over: no round pending, running or stalled, no blocking or major finding open;
 * - Review PRs, when it is on for the task, reviewed this head and found nothing at or above the fix threshold;
 * - no review or fix of the task's PRs is running, and no reviewer requested changes on GitHub;
 * - its checks pass, or none has reported for NO_CHECKS_WAIT_MS since the head was first seen (GitHub reports none
 *   for a moment after a push), and GitHub says it merges cleanly.
 */
export function notMergeable(
  services: Services,
  task: TaskSummary,
  link: PrLink,
  branch: string,
  runs: readonly AutopilotRun[],
  timing: { now: number; headSince: number },
): string | null {
  const snapshot = link.snapshot;
  if (task.kind === "epic" || task.archivedAt !== null) return "it isn't an open task";
  if (task.status !== "review") return "it isn't in Review";
  if (!snapshot || snapshot.state !== "open") return `PR #${link.ref.number} isn't open and ready for review`;
  if (snapshot.baseRef !== branch) return `PR #${link.ref.number} doesn't target ${branch}`;
  if (!snapshot.headOid) return `PR #${link.ref.number} has no head commit yet`;
  if (task.review) {
    if (reviewIsInProgress(task.review, services.reviews.effectiveAutoReview(task.id))) {
      return "its local review is still going";
    }
    if (task.review.open.blocking + task.review.open.major > 0) {
      return "its local review left blocking or major findings open";
    }
  }
  const active = runs.filter(
    (r) =>
      !r.dryRun &&
      AUTOPILOT_ACTIVE_STATUSES.includes(r.status) &&
      (r.automation === AUTOPILOT_REVIEW_PRS || r.automation === AUTOPILOT_FIX_PRS),
  );
  if (active.length > 0) return "a review or fix of its PR is running";
  if (reviewPrsOn(services, task)) {
    const verdict = currentPrReview(runs, link.id, snapshot.headOid);
    if (!verdict) return `Review PRs hasn't reviewed PR #${link.ref.number} at its head yet`;
    if (verdict.actionable > 0)
      return `Review PRs found ${verdict.actionable} point(s) at or above ${verdict.threshold}`;
  }
  if (snapshot.reviewDecision === "changes_requested") return `a reviewer requested changes on PR #${link.ref.number}`;
  if (snapshot.checks !== "passing" && snapshot.checks !== "none") return `its checks are ${snapshot.checks}`;
  if (snapshot.checks === "none" && !(timing.now - timing.headSince >= NO_CHECKS_WAIT_MS)) {
    return `no checks have reported on PR #${link.ref.number} yet`;
  }
  if (snapshot.mergeable !== "mergeable") {
    return snapshot.mergeable === "conflicting"
      ? `PR #${link.ref.number} conflicts with ${branch}`
      : "GitHub hasn't said it merges cleanly yet";
  }
  return null;
}
