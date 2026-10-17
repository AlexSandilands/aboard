import type { TaskSummary } from "./schemas.ts";

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
