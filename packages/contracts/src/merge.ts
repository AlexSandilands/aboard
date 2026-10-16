import { z } from "zod";
import { MergeMethod, type PrSnapshot, type TaskStatus } from "./schemas.ts";

/**
 * What the merge control on a PR link offers:
 * - `merge`: merge now;
 * - `auto`: turn on auto-merge, since checks haven't passed yet;
 * - `armed`: auto-merge is already on (offer turning it off);
 * - null: nothing.
 */
export type PrMergeAction = "merge" | "auto" | "armed";

/**
 * The merge control for a task's PR. Only tasks in Review offer one, and only when the signed-in
 * account can merge. GitHub has the final say: this only picks the button.
 */
export function prMergeAction(taskStatus: TaskStatus, snapshot: PrSnapshot | null | undefined): PrMergeAction | null {
  if (taskStatus !== "review" || !snapshot?.canMerge) return null;
  if (snapshot.state !== "open") return null;
  if (snapshot.mergeable === "conflicting") return null;
  if (snapshot.autoMerge) return "armed";
  if (!snapshot.mergeMethods || snapshot.mergeMethods.length === 0) return null;
  if (snapshot.checks !== "passing" && snapshot.checks !== "none" && snapshot.autoMergeAllowed) return "auto";
  return "merge";
}

const METHOD_PREFERENCE: readonly MergeMethod[] = ["squash", "merge", "rebase"];

/** The method to offer: the last one picked for the repo if still allowed, else squash, merge, rebase. */
export function pickMergeMethod(
  allowed: readonly MergeMethod[],
  lastPicked: MergeMethod | null | undefined,
): MergeMethod | null {
  if (lastPicked && allowed.includes(lastPicked)) return lastPicked;
  return METHOD_PREFERENCE.find((m) => allowed.includes(m)) ?? null;
}

export const MergePrAction = z.enum(["merge", "auto", "disable_auto"]);
export type MergePrAction = z.infer<typeof MergePrAction>;

export const MergePrInput = z
  .object({
    action: MergePrAction,
    /** Required to merge or turn on auto-merge; ignored when turning it off. */
    method: MergeMethod.optional(),
  })
  .refine((input) => input.action === "disable_auto" || input.method !== undefined, {
    message: "method is required",
    path: ["method"],
  });
export type MergePrInput = z.infer<typeof MergePrInput>;
