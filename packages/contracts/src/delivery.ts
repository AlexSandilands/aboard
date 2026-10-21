import type { IntegrationMerge, TaskLink, TaskSummary } from "./schemas.ts";

/** Where every integration branch lives, so it reads as the epic's and never as a task's or Autopilot's own. */
export const EPIC_BRANCH_PREFIX = "epic/";

/** An epic's integration branch: `epic/<number>-<slug of the title>`, e.g. `epic/12-one-page-checkout`. */
export function epicBranchName(epic: { number: number; title: string }): string {
  const slug = epic.title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return `${EPIC_BRANCH_PREFIX}${epic.number}${slug ? `-${slug}` : ""}`;
}

type ChildLike = Pick<TaskSummary, "id" | "number" | "status" | "resolution" | "archivedAt" | "blockedBy">;

/**
 * An epic's tasks that have started: past Planned (In Progress, Review, or Done without being closed). Once one has,
 * its branch and pull request already target the epic's base, so the delivery can no longer switch back to main.
 */
export function startedEpicTasks<T extends ChildLike>(children: readonly T[]): T[] {
  return children.filter(
    (c) =>
      c.archivedAt === null &&
      (c.status === "in_progress" || c.status === "review" || (c.status === "done" && c.resolution === null)),
  );
}

/**
 * Whether to ask the user about integration-branch delivery for an epic: nobody chose a delivery yet, it is still open,
 * and its tasks look like they build on each other (two or more open ones with a blocks / blocked-by relation between
 * them) or there are enough of them to run as one feature (three or more Planned).
 */
export function deliveryHintApplies(
  epic: Pick<TaskSummary, "kind" | "delivery" | "archivedAt" | "status">,
  children: readonly ChildLike[],
): boolean {
  if (epic.kind !== "epic" || epic.delivery !== null || epic.archivedAt !== null || epic.status === "done")
    return false;
  const open = children.filter((c) => c.archivedAt === null && c.status !== "done");
  const ids = new Set(open.map((c) => c.id));
  const related = open.some((c) => c.blockedBy.some((b) => ids.has(b.id)));
  return (open.length >= 2 && related) || open.filter((c) => c.status === "planned").length >= 3;
}

/** Autopilot's "Merge into epic branch": merges task PRs into an integration epic's branch and keeps its PR. */
export const AUTOPILOT_MERGE_EPIC_PRS = "merge_epic_prs";

/**
 * Whether an integration epic's branch has merged into the default branch, and how the board knows: its PR from the
 * branch (any linked PR whose head is the branch) shows merged, or the user marked it merged by hand. `pr` is that PR
 * even while it is open, so the panel can link to what the epic is waiting for. Null for an epic that delivers to
 * main (or has no delivery chosen), and for anything that isn't an epic.
 */
export function epicBranchMerge(
  epic: Pick<TaskSummary, "kind" | "delivery" | "integrationBranch"> & { integrationMergedAt: string | null },
  links: readonly TaskLink[],
): IntegrationMerge | null {
  if (epic.kind !== "epic" || epic.delivery !== "integration" || !epic.integrationBranch) return null;
  const branch = epic.integrationBranch;
  const prs = links.flatMap((l) => (l.kind === "pr" && l.ref && l.snapshot?.headRef === branch ? [l] : []));
  const merged = prs.find((l) => l.snapshot?.state === "merged");
  const shown = merged ?? prs[0];
  const pr = shown?.ref ?? null;
  if (merged) return { merged: true, by: "pr", pr };
  if (epic.integrationMergedAt) return { merged: true, by: "manual", pr };
  return { merged: false, by: null, pr };
}

/**
 * Whether an integration epic's tasks are all done and only the merge of its branch into the default branch is left:
 * the state in which it sits in Review with a "waiting for merge" badge, and can be marked merged.
 */
export function awaitingBranchMerge(task: Pick<TaskSummary, "integrationMerge" | "rollup">): boolean {
  return (
    task.integrationMerge?.merged === false &&
    task.rollup !== null &&
    task.rollup.total > 0 &&
    task.rollup.done === task.rollup.total
  );
}
