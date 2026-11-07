import type { TaskSummary } from "@repo/contracts";

/** What Merge ready PRs' detail shows from the board: the epics that deliver through a branch, and the flagged tasks. */
export interface MergeTargetsInfo {
  /** Open epics with an integration branch, by number. */
  epics: Array<{ number: number; title: string; branch: string }>;
  /** Unfinished tasks flagged for auto-merge that go to main (not through an epic's branch), by number. */
  flagged: Array<{ number: number; title: string }>;
}

type Summary = Pick<
  TaskSummary,
  "kind" | "number" | "title" | "status" | "archivedAt" | "integrationBranch" | "autoMerge"
>;

export function mergeTargetsInfo(tasks: readonly Summary[]): MergeTargetsInfo {
  const open = tasks.filter((t) => t.archivedAt === null && t.status !== "done").sort((a, b) => a.number - b.number);
  return {
    epics: open.flatMap((t) =>
      t.kind === "epic" && t.integrationBranch
        ? [{ number: t.number, title: t.title, branch: t.integrationBranch }]
        : [],
    ),
    flagged: open
      .filter((t) => t.kind !== "epic" && t.autoMerge === true && !t.integrationBranch)
      .map((t) => ({ number: t.number, title: t.title })),
  };
}

/** "#5 One-page checkout, #14 Offline mode and 2 more": at most `max` named. */
export function refList(items: ReadonlyArray<{ number: number; title: string }>, max = 2): string {
  const named = items.slice(0, max).map((i) => `#${i.number} ${i.title}`);
  const rest = items.length - named.length;
  if (rest > 0) return `${named.join(", ")} and ${rest} more`;
  return named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}` : (named[0] ?? "");
}

/** The status under Epic branches, one fact: which epics deliver through a branch of their own. */
export function epicsStatus(info: MergeTargetsInfo): string {
  const n = info.epics.length;
  if (n === 0) return "No epic uses one yet";
  return `${n === 1 ? "1 epic" : `${n} epics`}: ${refList(info.epics)}`;
}

/** The status under Main, one fact: which tasks are flagged Auto-merge (the switch beside it says whether they merge). */
export function flaggedStatus(info: MergeTargetsInfo): string {
  const n = info.flagged.length;
  if (n === 0) return "No task is flagged Auto-merge";
  return `${n} flagged: ${refList(info.flagged)}`;
}
