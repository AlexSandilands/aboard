import { z } from "zod";

// Local review: rounds of review on a task, each with findings the implementing agent fixes or declines.
// The loop runs before the PR is opened; see docs/integrations/local-review.md.

/** blocking and major findings keep the loop going; minor and nit may stay open. */
export const FindingSeverity = z.enum(["blocking", "major", "minor", "nit"]);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

export const FINDING_SEVERITIES: ReadonlyArray<FindingSeverity> = FindingSeverity.options;

/** Severities that must be resolved before a review counts as clean. */
export const isGatingSeverity = (severity: FindingSeverity): boolean => severity === "blocking" || severity === "major";

export const FindingStatus = z.enum(["open", "fixed", "wont_fix"]);
export type FindingStatus = z.infer<typeof FindingStatus>;

/**
 * A round's lifecycle: opened as pending (waiting for a reviewer), running while the board's own headless
 * reviewer works on it, stalled when no reviewer picked it up and no fallback could run, then submitted
 * (findings recorded) or failed.
 */
export const ReviewRoundStatus = z.enum(["pending", "running", "stalled", "submitted", "failed"]);
export type ReviewRoundStatus = z.infer<typeof ReviewRoundStatus>;

/** What opened the round: a move to Review, an explicit request (start_review / button), or a re-review. */
export const ReviewTrigger = z.enum(["move", "manual"]);
export type ReviewTrigger = z.infer<typeof ReviewTrigger>;

/** A skill the reviewer follows. `builtin` is the board's own review skill. */
export const ReviewSkillRef = z.discriminatedUnion("source", [
  z.object({ source: z.literal("builtin") }),
  z.object({
    source: z.enum(["global", "project"]),
    name: z.string().min(1),
    /** Absolute path to the SKILL.md. */
    path: z.string().min(1),
  }),
]);
export type ReviewSkillRef = z.infer<typeof ReviewSkillRef>;

export const BUILTIN_REVIEW_SKILL_NAME = "aboard-review";

/** Actor the board's own headless reviewer records rounds as. */
export const BOARD_REVIEWER = "board reviewer";

export const reviewSkillName = (skill: ReviewSkillRef): string =>
  skill.source === "builtin" ? BUILTIN_REVIEW_SKILL_NAME : skill.name;

export const ReviewFinding = z.object({
  id: z.string(),
  reviewId: z.string(),
  /** "R<round>.<n>", e.g. "R2.3": how agents refer to a finding. */
  label: z.string(),
  severity: FindingSeverity,
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  title: z.string(),
  body: z.string().nullable(),
  suggestion: z.string().nullable(),
  status: FindingStatus,
  resolutionNote: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

export const TaskReview = z.object({
  id: z.string(),
  taskId: z.string(),
  round: z.number().int().positive(),
  /** Each move to Review starts a new cycle; the round limit applies per cycle. */
  cycle: z.number().int().positive(),
  status: ReviewRoundStatus,
  trigger: ReviewTrigger,
  openedBy: z.string(),
  /** Who submitted the findings (an agent label, or the headless runner). */
  reviewer: z.string().nullable(),
  /** Name of the skill the reviewer was asked to follow. */
  skill: z.string().nullable(),
  headSha: z.string().nullable(),
  summary: z.string().nullable(),
  /** Why the round failed or stalled. */
  error: z.string().nullable(),
  /** When the board asked the task's T3 thread to run this round, because no reviewer had. */
  nudgedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  findings: z.array(ReviewFinding),
});
export type TaskReview = z.infer<typeof TaskReview>;

/**
 * The card badge, derived from the rounds:
 * - pending / running / stalled / failed: the latest round's own status;
 * - changes_requested: blocking or major findings are open and rounds remain;
 * - stuck: they are still open after the last allowed round;
 * - fixed: the latest round raised blocking or major findings and all are resolved, but unverified;
 * - clean: the latest round raised none and none are open from earlier rounds.
 */
export const ReviewState = z.enum([
  "pending",
  "running",
  "stalled",
  "failed",
  "changes_requested",
  "stuck",
  "fixed",
  "clean",
]);
export type ReviewState = z.infer<typeof ReviewState>;

const SeverityCounts = z.object({
  blocking: z.number().int(),
  major: z.number().int(),
  minor: z.number().int(),
  nit: z.number().int(),
});
export type SeverityCounts = z.infer<typeof SeverityCounts>;

export const TaskReviewSummary = z.object({
  state: ReviewState,
  /** Rounds so far in the current cycle. */
  round: z.number().int(),
  maxRounds: z.number().int(),
  /** Open findings across all rounds, by severity. */
  open: SeverityCounts,
  /** The latest round was reviewed by the board's own reviewer, not an agent running the loop. */
  byBoard: z.boolean(),
});
export type TaskReviewSummary = z.infer<typeof TaskReviewSummary>;

export const DEFAULT_REVIEW_MAX_ROUNDS = 3;

/** Minimal shapes so the derivation works on DB records and contract objects alike. */
interface RoundLike {
  round: number;
  cycle: number;
  status: ReviewRoundStatus;
  reviewer: string | null;
}
interface FindingLike {
  /** The round that raised it. */
  round: number;
  severity: FindingSeverity;
  status: FindingStatus;
}

export function deriveReviewSummary(
  rounds: ReadonlyArray<RoundLike>,
  findings: ReadonlyArray<FindingLike>,
  maxRounds: number,
): TaskReviewSummary | null {
  const latest = rounds.reduce<RoundLike | null>((acc, r) => (acc && acc.round > r.round ? acc : r), null);
  if (!latest) return null;
  const open: SeverityCounts = { blocking: 0, major: 0, minor: 0, nit: 0 };
  for (const f of findings) if (f.status === "open") open[f.severity] += 1;
  const cycleRounds = rounds.filter((r) => r.cycle === latest.cycle).length;
  const base = { round: cycleRounds, maxRounds, open, byBoard: latest.reviewer === BOARD_REVIEWER };
  if (latest.status !== "submitted") return { ...base, state: latest.status };
  if (open.blocking + open.major > 0) {
    return { ...base, state: cycleRounds >= maxRounds ? "stuck" : "changes_requested" };
  }
  const raisedGating = findings.some((f) => f.round === latest.round && isGatingSeverity(f.severity));
  return { ...base, state: raisedGating ? "fixed" : "clean" };
}

/** Whether the implementing agent should run another round. */
export const reviewWantsAnotherRound = (summary: TaskReviewSummary | null): boolean =>
  summary !== null &&
  (summary.state === "changes_requested" || summary.state === "fixed") &&
  summary.round < summary.maxRounds;

/** Short badge text for cards. */
export function reviewBadgeLabel(summary: TaskReviewSummary): string {
  const gating = summary.open.blocking + summary.open.major;
  switch (summary.state) {
    case "pending":
      return "Reviewing";
    case "running":
      return "Reviewing";
    case "stalled":
      return "Needs review";
    case "failed":
      return "Review failed";
    case "changes_requested":
      return `${gating} open`;
    case "stuck":
      return `Stuck: ${gating} open`;
    case "fixed":
      return "Fixed, re-review";
    case "clean":
      return "Reviewed";
  }
}

// ── Inputs ───────────────────────────────────────────────────────────────

export const ReviewFindingInput = z.object({
  severity: FindingSeverity,
  title: z.string().trim().min(1),
  file: z.string().trim().min(1).optional(),
  line: z.number().int().positive().optional(),
  body: z.string().optional(),
  suggestion: z.string().optional(),
});
export type ReviewFindingInput = z.infer<typeof ReviewFindingInput>;

export const SubmitReviewInput = z.object({
  /** Defaults to the latest pending or running round. */
  round: z.number().int().positive().optional(),
  summary: z.string().optional(),
  headSha: z.string().trim().min(1).optional(),
  findings: z.array(ReviewFindingInput),
});
export type SubmitReviewInput = z.infer<typeof SubmitReviewInput>;

export const ResolveFindingInput = z.object({
  status: FindingStatus,
  note: z.string().optional(),
});
export type ResolveFindingInput = z.infer<typeof ResolveFindingInput>;

/** A SKILL.md found on disk, offered as a review skill. */
export const SkillInfo = z.object({
  source: z.enum(["global", "project"]),
  name: z.string(),
  description: z.string().nullable(),
  /** Absolute path to the SKILL.md. */
  path: z.string(),
  /** The folder it was found in, e.g. "~/.claude/skills" or ".github/skills", for display. */
  root: z.string(),
});
export type SkillInfo = z.infer<typeof SkillInfo>;
