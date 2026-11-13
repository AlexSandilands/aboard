import type { TaskReviewSummary } from "./reviews.ts";
import { sessionHealth } from "./sessionHealth.ts";
import {
  TaskStatus,
  type AttentionDismissal,
  type AttentionReason,
  type AttentionRequest,
  type CurrentStep,
  type DismissedAttention,
  type EpicRollup,
  type PlanPhase,
  type StepStatus,
  type TaskImport,
  type TaskRelation,
  type TaskLink,
} from "./schemas.ts";

/** Whether any blocker is still open: a blocker is finished only once Done, whatever its resolution. */
export function isBlocked(blockedBy: ReadonlyArray<Pick<TaskRelation, "status">>): boolean {
  return blockedBy.some((b) => b.status !== "done");
}

/** Statuses that count as finished for progress. */
export function isStepComplete(status: StepStatus): boolean {
  return status === "done" || status === "skipped";
}

export function deriveProgress(phases: ReadonlyArray<PlanPhase>): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const phase of phases) {
    for (const step of phase.steps) {
      total += 1;
      if (isStepComplete(step.status)) done += 1;
    }
  }
  return { done, total };
}

/**
 * The step the task is "up to": first in_progress step, else first blocked,
 * else the first todo after the last completed step, else the first todo.
 * Phases and steps must already be sorted by position.
 */
export function deriveCurrentStep(phases: ReadonlyArray<PlanPhase>): CurrentStep | null {
  const flat = phases.flatMap((phase, phaseIndex) =>
    phase.steps.map((step, stepIndex) => ({
      step,
      phase,
      index: `${phaseIndex + 1}.${stepIndex + 1}`,
    })),
  );
  const pick =
    flat.find((e) => e.step.status === "in_progress") ??
    flat.find((e) => e.step.status === "blocked") ??
    (() => {
      let lastDone = -1;
      flat.forEach((e, i) => {
        if (isStepComplete(e.step.status)) lastDone = i;
      });
      return (
        flat.slice(lastDone + 1).find((e) => e.step.status === "todo") ?? flat.find((e) => e.step.status === "todo")
      );
    })();
  if (!pick) return null;
  return {
    id: pick.step.id,
    title: pick.step.title,
    phaseTitle: pick.phase.title,
    status: pick.step.status,
    index: pick.index,
  };
}

export interface AttentionInput {
  phases: ReadonlyArray<PlanPhase>;
  links: ReadonlyArray<TaskLink>;
  /** The task's status. A Done task's failed sessions are history, so they stop flagging; absent means not Done. */
  status?: TaskStatus;
  review?: TaskReviewSummary | null;
  issueImport?: TaskImport | null;
  /** Why an Autopilot run on the task needs the user (see the autopilot_runs repo); null when none does. */
  autopilot?: string | null;
  /** An agent's standing request for the user (request_attention); null when none. */
  request?: AttentionRequest | null;
  /** What the user dismissed on this task. One hides a reason only while its fingerprint still matches. */
  dismissals?: ReadonlyArray<AttentionDismissal>;
}

/** Keys of the two reasons with a dismissal of their own (clearing the request, dismissing the runs). */
export const ATTENTION_REQUEST_KEY = "request";
export const ATTENTION_AUTOPILOT_KEY = "autopilot";

/**
 * What needs the user on a task, and what would if they hadn't dismissed it. Every reason carries a `key` (what
 * raised it) and a `fingerprint` (the state that raised it); a dismissal stands while both match.
 */
export function deriveAttention(input: AttentionInput): {
  attention: AttentionReason[];
  dismissed: DismissedAttention[];
} {
  const { phases, links, status, review = null, issueImport = null, autopilot = null, request = null } = input;
  const reasons: AttentionReason[] = [];
  if (request) {
    reasons.push({
      kind: "agent_request",
      severity: "warning",
      message: request.message,
      key: ATTENTION_REQUEST_KEY,
      fingerprint: request.requestedAt,
    });
  }
  if (autopilot) {
    reasons.push({
      kind: "autopilot",
      severity: "warning",
      message: autopilot,
      key: ATTENTION_AUTOPILOT_KEY,
      fingerprint: autopilot,
    });
  }
  if (issueImport?.status === "failed") {
    reasons.push({
      kind: "import_failed",
      severity: "warning",
      message: issueImport.error ? `Import failed: ${issueImport.error}` : "Import failed",
      key: "import",
      fingerprint: `${issueImport.error ?? ""}@${issueImport.updatedAt ?? ""}`,
    });
  }
  const blocked = phases.flatMap((p) => p.steps).filter((s) => s.status === "blocked");
  if (blocked.length > 0) {
    reasons.push({
      kind: "blocked_step",
      severity: "warning",
      message: blocked.length === 1 ? `Blocked: ${blocked[0]!.title}` : `${blocked.length} steps blocked`,
      key: "steps",
      fingerprint: blocked
        .map((s) => s.id)
        .sort()
        .join(","),
    });
  }
  for (const link of links) {
    if (link.kind === "pr" && link.snapshot && (link.snapshot.state === "open" || link.snapshot.state === "draft")) {
      const label = link.ref ? `#${link.ref.number}` : "PR";
      // The head commit: a push is what makes failing checks, a review or a conflict a new problem. Snapshots from
      // hosts that don't report it fall back to the PR's last change.
      const fingerprint = link.snapshot.headOid ?? link.snapshot.updatedAt ?? "";
      if (link.snapshot.checks === "failing") {
        reasons.push({
          kind: "pr_checks_failing",
          severity: "error",
          message: `${label} checks failing`,
          key: `pr:${link.id}:checks`,
          fingerprint,
        });
      }
      if (link.snapshot.reviewDecision === "changes_requested") {
        reasons.push({
          kind: "pr_changes_requested",
          severity: "warning",
          message: `${label} changes requested`,
          key: `pr:${link.id}:changes`,
          fingerprint,
        });
      }
      if (link.snapshot.mergeable === "conflicting") {
        reasons.push({
          kind: "pr_conflict",
          severity: "warning",
          message: `${label} has conflicts`,
          key: `pr:${link.id}:conflict`,
          fingerprint,
        });
      }
    }
    const health = sessionHealth(link);
    if (health && !health.autopilotRun) {
      const identity = { key: sessionReasonKey(link.id), fingerprint: `${health.status}@${health.activityAt ?? ""}` };
      if (health.state === "waiting") {
        reasons.push({
          kind: "session_needs_input",
          severity: "warning",
          message: `${health.noun} awaiting ${health.waitingFor ?? "input"}`,
          ...identity,
        });
      } else if (health.state === "failed" && status !== "done") {
        reasons.push({ kind: "session_failed", severity: "error", message: `${health.noun} failed`, ...identity });
      }
    }
  }
  // A review mid-loop (pending, changes requested, fixed) is the agent's business; only a loop that ended
  // without a clean result needs the user.
  const reviewIdentity = { key: "review", fingerprint: `${review?.state}:${review?.round}` };
  if (review?.state === "stalled") {
    reasons.push({
      kind: "review_stalled",
      severity: "warning",
      message: "Needs review: no reviewer ran",
      ...reviewIdentity,
    });
  } else if (review?.state === "stuck") {
    const open = review.open.blocking + review.open.major;
    reasons.push({
      kind: "review_stuck",
      severity: "warning",
      message: `Review: ${open} open after ${review.round} round${review.round === 1 ? "" : "s"}`,
      ...reviewIdentity,
    });
  } else if (review?.state === "failed") {
    reasons.push({ kind: "review_failed", severity: "error", message: "Review failed", ...reviewIdentity });
  } else if (review?.state === "changes_requested" && review.byBoard) {
    // The board's own reviewer found these, so no agent is looping on them unless one is nudged.
    const open = review.open.blocking + review.open.major;
    reasons.push({
      kind: "review_unattended",
      severity: "warning",
      message: `Board review: ${open} to fix`,
      ...reviewIdentity,
    });
  }
  const dismissals = new Map((input.dismissals ?? []).map((d) => [d.key, d]));
  const attention: AttentionReason[] = [];
  const dismissed: DismissedAttention[] = [];
  for (const reason of reasons) {
    const dismissal = dismissals.get(reason.key);
    if (dismissal && dismissal.fingerprint === reason.fingerprint) {
      dismissed.push({ ...reason, dismissedAt: dismissal.dismissedAt, dismissedBy: dismissal.actor });
    } else attention.push(reason);
  }
  return { attention, dismissed };
}

/** The key of the reason a session link raises (`session_failed`, `session_needs_input`). */
export const sessionReasonKey = (linkId: string): string => `link:${linkId}`;

/** Compact plaintext rendering for agents: "1.2 [x] Write migrations". */
export function formatPlanText(phases: ReadonlyArray<PlanPhase>, current?: CurrentStep | null): string {
  const mark: Record<StepStatus, string> = {
    todo: "[ ]",
    in_progress: "[~]",
    done: "[x]",
    blocked: "[!]",
    skipped: "[-]",
  };
  const lines: string[] = [];
  phases.forEach((phase, pi) => {
    lines.push(`Phase ${pi + 1}: ${phase.title}`);
    phase.steps.forEach((step, si) => {
      const here = current?.id === step.id ? "   <- current" : "";
      lines.push(`  ${pi + 1}.${si + 1} ${mark[step.status]} ${step.title}  (id: ${step.id})${here}`);
    });
  });
  return lines.join("\n");
}

/** Counts an epic's children by status. Pass only the children that count (not archived). */
export function deriveEpicRollup(children: ReadonlyArray<{ status: TaskStatus }>): EpicRollup {
  const byStatus = Object.fromEntries(TaskStatus.options.map((s) => [s, 0])) as Record<TaskStatus, number>;
  for (const child of children) byStatus[child.status] += 1;
  return { total: children.length, done: byStatus.done, byStatus };
}

/** Furthest along first: the order an epic's roll-up bar fills in and its summary lists statuses. */
export const ROLLUP_ORDER: ReadonlyArray<TaskStatus> = ["done", "review", "in_progress", "planned", "backlog"];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  planned: "Planned",
  in_progress: "In Progress",
  review: "Review",
  done: "Done",
};

/** "2/5 done · 2 In Progress, 1 Backlog", or "No tasks yet". */
export function describeEpicRollup(rollup: EpicRollup): string {
  if (rollup.total === 0) return "No tasks yet";
  const open = ROLLUP_ORDER.filter((s) => s !== "done" && rollup.byStatus[s] > 0)
    .map((s) => `${rollup.byStatus[s]} ${STATUS_LABELS[s]}`)
    .join(", ");
  return `${rollup.done}/${rollup.total} done${open ? ` · ${open}` : ""}`;
}

/**
 * An epic sits where its furthest-back open child is, so the column shows how far the whole feature has got.
 * Done once every child is done or closed; Backlog while it has no children. `awaitingMerge` is an integration epic
 * whose branch hasn't merged into the default branch: its work is finished but not delivered, so it stays in Review.
 */
export function deriveEpicStatus(rollup: EpicRollup, awaitingMerge = false): TaskStatus {
  if (rollup.total === 0) return "backlog";
  const status = TaskStatus.options.find((s) => rollup.byStatus[s] > 0) ?? "backlog";
  return status === "done" && awaitingMerge ? "review" : status;
}

export type DueState = "overdue" | "today" | "later";

/** Where a `YYYY-MM-DD` due date stands against `today` (the viewer's local date, same format). */
export function dueState(dueDate: string, today: string): DueState {
  // Both are zero-padded ISO dates, so string order is date order.
  return dueDate < today ? "overdue" : dueDate === today ? "today" : "later";
}
