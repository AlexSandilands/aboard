import {
  parseGithubMilestone,
  parseImportSource,
  ticketLabel,
  type TaskImport,
  type TaskKind,
  type TicketSystem,
} from "@repo/contracts";

/** Where a task's import reads from: "<System> PROJ-1" or "GitHub acme/app#45" or "GitHub acme/app milestone 7". */
export function importSourceLabel(sourceUrl: string, ticketSystems: readonly TicketSystem[] = []): string {
  const source = parseImportSource(sourceUrl, ticketSystems);
  if (source?.kind === "ticket") return ticketLabel(ticketSystems, source.ref);
  if (source?.kind === "issue" || source?.kind === "milestone") return `GitHub ${source.placeholder}`;
  return sourceUrl;
}

/** Whether an import reads a GitHub milestone, which becomes an epic of its open issues. */
export function isMilestoneImport(sourceUrl: string): boolean {
  return parseGithubMilestone(sourceUrl) !== null;
}

/** What the card and panel say while an import runs. Null once it has finished or failed. */
export function importPendingLabel(task: { import: TaskImport | null }): string | null {
  return task.import?.status === "pending" ? "Fetching details…" : null;
}

/** The panel's callout for a failed import: what failed, and the reason. Null unless it failed. */
export function importFailure(
  task: { import: TaskImport | null },
  ticketSystems: readonly TicketSystem[] = [],
): { title: string; reason: string } | null {
  const failed = task.import;
  if (failed?.status !== "failed") return null;
  return {
    title: `Couldn't import ${importSourceLabel(failed.sourceUrl, ticketSystems)}`,
    reason: failed.error ?? "The import failed.",
  };
}

/**
 * An imported epic's tasks while some of them are still importing: how many have finished (or failed) of those created
 * from an issue. Null for anything else, and once they all have.
 */
export function epicImportProgress(task: {
  kind: TaskKind;
  import: TaskImport | null;
  children: ReadonlyArray<{ import: TaskImport | null }>;
}): { done: number; total: number } | null {
  if (task.kind !== "epic" || !task.import) return null;
  const imported = task.children.filter((c) => c.import !== null);
  const done = imported.filter((c) => c.import!.status !== "pending").length;
  return done < imported.length ? { done, total: imported.length } : null;
}
