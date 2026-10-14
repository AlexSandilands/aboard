import type { TaskResolution, TaskSummary } from "@repo/contracts";

/** Short card/panel label: "Done by #4", "Duplicate of #4", "Won't do"; null for open tasks. */
export function resolutionLabel(task: Pick<TaskSummary, "resolution" | "resolvedBy">): string | null {
  const by = task.resolvedBy ? ` #${task.resolvedBy.number}` : "";
  switch (task.resolution) {
    case "completed":
      return by ? `Done by${by}` : "Done elsewhere";
    case "duplicate":
      return by ? `Duplicate of${by}` : "Duplicate";
    case "wont_do":
      return "Won't do";
    case null:
      return null;
  }
}

/** Title of the picker dialog for resolutions that point at another task. */
export function closeDialogTitle(number: number, resolution: Exclude<TaskResolution, "wont_do">): string {
  return resolution === "completed" ? `Close #${number} as done by…` : `Close #${number} as a duplicate of…`;
}

const MAX_CANDIDATES = 50;

/**
 * Tasks the picker offers as the delivering/original task: every other task matching `query` (by "#n", number
 * or title words), the closing task's own project first, then newest first.
 */
export function closeCandidates(
  tasks: ReadonlyArray<TaskSummary>,
  self: Pick<TaskSummary, "id" | "projectId">,
  query: string,
): TaskSummary[] {
  const q = query.trim().toLowerCase();
  const number = /^#?(\d+)$/.exec(q);
  const words = q.split(/\s+/).filter(Boolean);
  const matches = (task: TaskSummary) => {
    if (!q) return true;
    if (number && task.number === Number(number[1])) return true;
    const haystack = `#${task.number} ${task.title}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  };
  return tasks
    .filter((task) => task.id !== self.id && matches(task))
    .sort((a, b) => {
      const sameA = a.projectId === self.projectId ? 0 : 1;
      const sameB = b.projectId === self.projectId ? 0 : 1;
      return sameA - sameB || b.number - a.number;
    })
    .slice(0, MAX_CANDIDATES);
}
