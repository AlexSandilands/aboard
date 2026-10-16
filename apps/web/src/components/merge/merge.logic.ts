import type { MergeMethod, PrMergeAction, PrRef } from "@repo/contracts";

/** Key for the per-repo last-picked method: the same repo on two hosts is two repos. */
export const mergeRepoKey = (ref: PrRef): string => `${ref.host}/${ref.repo}`.toLowerCase();

/** GitHub's own names for the methods, as its merge button shows them. */
export const MERGE_METHOD_LABEL: Record<MergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
};

/** The dialog's wording for a merge now or turning on auto-merge. */
export function mergeDialogCopy(action: Exclude<PrMergeAction, "armed">): {
  title: string;
  confirm: string;
  pending: string;
  explain: string;
} {
  return action === "auto"
    ? {
        title: "Enable auto-merge",
        confirm: "Enable auto-merge",
        pending: "Enabling…",
        explain: "GitHub merges it once the required checks pass and reviews are in. The task moves to Done then.",
      }
    : {
        title: "Merge pull request",
        confirm: "Merge",
        pending: "Merging…",
        explain: "The task moves to Done once GitHub reports the merge. The branch isn't deleted.",
      };
}

/** Label of the panel row's merge button. */
export const mergeButtonLabel = (action: Exclude<PrMergeAction, "armed">): string =>
  action === "auto" ? "Enable auto-merge" : "Merge";
