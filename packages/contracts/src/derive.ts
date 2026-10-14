import type { TaskReviewSummary } from "./reviews.ts";
import type { AttentionReason, CurrentStep, PlanPhase, StepStatus, TaskLink } from "./schemas.ts";

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
): AttentionReason[] {
  const reasons: AttentionReason[] = [];
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
