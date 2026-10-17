import { parseIssueSource, type TaskImport, type TaskKind } from "@repo/contracts";

/** Where a task's import reads from: "Jira PROJ-1" or "GitHub acme/app#45". */
export function importSourceLabel(sourceUrl: string): string {
  const source = parseIssueSource(sourceUrl);
  if (source?.kind === "jira") return `Jira ${source.key}`;
  if (source?.kind === "issue") return `GitHub ${source.placeholder}`;
  return sourceUrl;
}

/** What the card and panel say while an import runs. Null once it has finished or failed. */
export function importPendingLabel(task: { import: TaskImport | null }): string | null {
  return task.import?.status === "pending" ? "Fetching details…" : null;
}

/** The panel's callout for a failed import: what failed, and the reason. Null unless it failed. */
export function importFailure(task: { import: TaskImport | null }): { title: string; reason: string } | null {
  const failed = task.import;
  if (failed?.status !== "failed") return null;
  return {
    title: `Couldn't import ${importSourceLabel(failed.sourceUrl)}`,
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
