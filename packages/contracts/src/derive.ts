import type { TaskReviewSummary } from "./reviews.ts";
import {
  TaskStatus,
  type AttentionReason,
  type AttentionRequest,
  type CurrentStep,
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

export function deriveAttention(
  phases: ReadonlyArray<PlanPhase>,
  links: ReadonlyArray<TaskLink>,
  review: TaskReviewSummary | null = null,
  issueImport: TaskImport | null = null,
  /** Why an Autopilot run on the task needs the user (see the autopilot_runs repo); null when none does. */
  autopilot: string | null = null,
  /** An agent's standing request for the user (request_attention); null when none. */
  request: AttentionRequest | null = null,
): AttentionReason[] {
  const reasons: AttentionReason[] = [];
  if (request) reasons.push({ kind: "agent_request", severity: "warning", message: request.message });
  if (autopilot) reasons.push({ kind: "autopilot", severity: "warning", message: autopilot });
  if (issueImport?.status === "failed") {
    reasons.push({
      kind: "import_failed",
      severity: "warning",
      message: issueImport.error ? `Import failed: ${issueImport.error}` : "Import failed",
    });
  }
  const blocked = phases.flatMap((p) => p.steps).filter((s) => s.status === "blocked");
  if (blocked.length > 0) {
    reasons.push({
      kind: "blocked_step",
      severity: "warning",
      message: blocked.length === 1 ? `Blocked: ${blocked[0]!.title}` : `${blocked.length} steps blocked`,
    });
  }
  for (const link of links) {
    if (link.kind === "pr" && link.snapshot && (link.snapshot.state === "open" || link.snapshot.state === "draft")) {
      const label = link.ref ? `#${link.ref.number}` : "PR";
      if (link.snapshot.checks === "failing") {
        reasons.push({ kind: "pr_checks_failing", severity: "error", message: `${label} checks failing` });
      }
      if (link.snapshot.reviewDecision === "changes_requested") {
        reasons.push({ kind: "pr_changes_requested", severity: "warning", message: `${label} changes requested` });
      }
      if (link.snapshot.mergeable === "conflicting") {
        reasons.push({ kind: "pr_conflict", severity: "warning", message: `${label} has conflicts` });
      }
    }
    if (link.kind === "t3_thread" && link.snapshot) {
      if (link.snapshot.status === "input" || link.snapshot.status === "approval") {
        reasons.push({
          kind: "thread_needs_input",
          severity: "warning",
          message: `Thread awaiting ${link.snapshot.status === "input" ? "input" : "approval"}`,
        });
      } else if (link.snapshot.status === "failed") {
        reasons.push({ kind: "thread_failed", severity: "error", message: "Thread failed" });
      }
    }
  }
  // A review mid-loop (pending, changes requested, fixed) is the agent's business; only a loop that ended
  // without a clean result needs the user.
  if (review?.state === "stalled") {
    reasons.push({ kind: "review_stalled", severity: "warning", message: "Needs review: no reviewer ran" });
  } else if (review?.state === "stuck") {
    const open = review.open.blocking + review.open.major;
    reasons.push({
      kind: "review_stuck",
      severity: "warning",
      message: `Review: ${open} open after ${review.round} round${review.round === 1 ? "" : "s"}`,
    });
  } else if (review?.state === "failed") {
    reasons.push({ kind: "review_failed", severity: "error", message: "Review failed" });
  } else if (review?.state === "changes_requested" && review.byBoard) {
    // The board's own reviewer found these, so no agent is looping on them unless one is nudged.
    const open = review.open.blocking + review.open.major;
    reasons.push({ kind: "review_unattended", severity: "warning", message: `Board review: ${open} to fix` });
  }
  return reasons;
}

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
 * Done once every child is done or closed; Backlog while it has no children.
 */
export function deriveEpicStatus(rollup: EpicRollup): TaskStatus {
  if (rollup.total === 0) return "backlog";
  return TaskStatus.options.find((s) => rollup.byStatus[s] > 0) ?? "backlog";
}

export type DueState = "overdue" | "today" | "later";

/** Where a `YYYY-MM-DD` due date stands against `today` (the viewer's local date, same format). */
export function dueState(dueDate: string, today: string): DueState {
  // Both are zero-padded ISO dates, so string order is date order.
  return dueDate < today ? "overdue" : dueDate === today ? "today" : "later";
}
