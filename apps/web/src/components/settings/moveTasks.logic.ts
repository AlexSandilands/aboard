import type { ImportProject, ImportTask, TransferMode } from "@repo/contracts";

/** Why a task can't be picked for this mode, or null when it can. */
export function blockedReason(task: ImportTask, mode: TransferMode): string | null {
  if (task.onBoard === "here") return "Already on this board";
  if (mode === "move" && task.movedTo)
    return `Moved to ${task.movedTo.machine} #${task.movedTo.number}: move it from there`;
  if (mode === "move" && task.busy) return "Work was going on it there: copy it, or move it once that's done";
  return null;
}

/** What the list says about a task besides its title. */
export function taskNote(task: ImportTask, projectTitle: string | null): string {
  return [
    projectTitle ?? "Unknown project",
    task.archived ? "archived there" : task.status.replace("_", " "),
    task.onBoard === "archived" ? "replaces the archived copy here" : null,
    task.busy ? "busy there" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The backup's projects that the picked tasks come from, each with the project here they go into: the one picked,
 * else the server's match, else null (the user has to pick one).
 */
export function projectTargets(
  projects: readonly ImportProject[],
  tasks: readonly ImportTask[],
  picked: ReadonlySet<string>,
  choices: Readonly<Record<string, string>>,
): Array<{ project: ImportProject; target: string | null }> {
  const used = new Set(tasks.filter((t) => picked.has(t.taskId)).map((t) => t.projectId));
  return projects
    .filter((p) => used.has(p.id))
    .map((project) => ({ project, target: choices[project.id] ?? project.matchId }));
}

/** The project here for each backup project the picked tasks come from, as sent with the import. */
export function projectMap(
  targets: ReadonlyArray<{ project: ImportProject; target: string | null }>,
): Record<string, string> {
  return Object.fromEntries(targets.flatMap(({ project, target }) => (target ? [[project.id, target]] : [])));
}

/** How a matched project was found, for the line under it. */
export function matchNote(project: ImportProject): string {
  switch (project.matchedBy) {
    case "id":
      return "The same project";
    case "remote":
      return `Same repo (${project.remote})`;
    case "name":
      return "Same name";
    default:
      return "No project here matches: pick one";
  }
}
