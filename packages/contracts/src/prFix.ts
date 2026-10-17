import { z } from "zod";
import { prMergeAction, type PrMergeAction } from "./merge.ts";
import type { PrSnapshot, TaskStatus } from "./schemas.ts";

// "Fix in →" on a PR link: start a session on the PR's own branch to fix what is wrong with it. The prompt is Fix PRs'
// (docs/features/github-prs.md#fixing-a-pr-by-hand); this is the shared rule for what the PR row offers.

/** What is wrong with a PR that a session could fix. */
export type PrProblem = "checks" | "conflict" | "changes";

/**
 * What is wrong with the PR now. Only an open or draft PR in the base repository has anything to fix: a fork's branch
 * isn't on `origin`, so there is nowhere to push. Needs the head the fix starts from.
 */
export function prProblems(snapshot: PrSnapshot | null | undefined): PrProblem[] {
  if (!snapshot || (snapshot.state !== "open" && snapshot.state !== "draft") || snapshot.isCrossRepository) return [];
  if (!snapshot.headRef || !snapshot.headOid) return [];
  return [
    ...(snapshot.checks === "failing" ? ["checks" as const] : []),
    ...(snapshot.mergeable === "conflicting" ? ["conflict" as const] : []),
    ...(snapshot.reviewDecision === "changes_requested" ? ["changes" as const] : []),
  ];
}

/** What Autopilot's Fix PRs is doing about the PR, as far as the board can tell. */
export type PrAutopilotState = "fixing" | "gave_up";

/** The start of the Needs attention message and run summary when Fix PRs gave up on PR #`number`. */
export const fixGaveUpPrefix = (number: number): string => `Autopilot gave up on PR #${number}:`;

/** The start of the dedupe key of every Fix PRs run on the PR link `linkId` (`fix:pr:<link>:<head>:<triggers>`). */
export const fixRunKeyPrefix = (linkId: string): string => `fix:pr:${linkId}:`;

/** The merge buttons: `armed` is a badge and a menu item of its own, not a slot. */
export type PrMergeButton = Exclude<PrMergeAction, "armed">;

/** What the PR row shows in its one action slot, and what moves into its ⌄ menu. */
export interface PrRowSlot {
  primary:
    | { kind: "merge"; action: PrMergeButton }
    | { kind: "fix" }
    | { kind: "autopilot"; state: PrAutopilotState }
    | null;
  menu: {
    /** The merge button that gave way to something else. */
    merge: PrMergeButton | null;
    /** "Fix in →", when the slot shows something else. */
    fix: boolean;
  };
}

/**
 * The one action slot of a PR row, in order: with something to fix, **Fix in →** takes the slot and Merge moves into
 * the menu; when Autopilot's Fix PRs is on for the task and says what it is doing (`autopilot`), its state takes the
 * slot and Fix in moves into the menu too, so the user can still step in by hand; with nothing to fix, **Merge** as
 * before. Done tasks aren't fixed, as Autopilot doesn't.
 */
export function prRowSlot(input: {
  taskStatus: TaskStatus;
  snapshot: PrSnapshot | null | undefined;
  /** The link has a repository and number, which the fix prompt is built from, and the task isn't an epic (its sessions start from its tasks). */
  canFix: boolean;
  /** Fix PRs' state for the task, or null when it is off or has nothing to say. */
  autopilot: PrAutopilotState | null;
}): PrRowSlot {
  const action = prMergeAction(input.taskStatus, input.snapshot);
  const merge: PrMergeButton | null = action === "merge" || action === "auto" ? action : null;
  const fixable = input.canFix && input.taskStatus !== "done" && prProblems(input.snapshot).length > 0;
  if (!fixable) return { primary: merge ? { kind: "merge", action: merge } : null, menu: { merge: null, fix: false } };
  if (input.autopilot) {
    return { primary: { kind: "autopilot", state: input.autopilot }, menu: { merge, fix: true } };
  }
  return { primary: { kind: "fix" }, menu: { merge, fix: false } };
}

/** `GET /api/links/:id/fix`: what "Fix in →" starts a session with. */
export const PrFixInfo = z.object({
  /** The PR's head branch: where the fix is pushed, and what a session's worktree starts from. */
  branch: z.string(),
  headOid: z.string(),
  number: z.number().int(),
  /** The PR's problems now, which the prompt lists. */
  problems: z.array(z.enum(["checks", "conflict", "changes"])),
  /** Fix PRs' prompt for them, for a user who is watching. */
  prompt: z.string(),
});
export type PrFixInfo = z.infer<typeof PrFixInfo>;
