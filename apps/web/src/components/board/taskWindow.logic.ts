// The task window: `?task=<id>&expanded=true` shows the open task in a large window over the board instead of the
// docked panel (see docs/features/board-layout.md#the-task-window). These build the board search for each move.

interface TaskSearch {
  task?: string;
  expanded?: true;
}

/**
 * The search with `taskId` open. `expanded` true opens it in the window, false docks it, and undefined keeps what the
 * open task had: a `#N` link followed inside the window stays in the window, and one followed from the docked panel
 * stays docked.
 */
export function withOpenTask<T extends TaskSearch>(prev: T, taskId: string, expanded?: boolean): T {
  const keep = expanded ?? (prev.task !== undefined && prev.expanded === true);
  return { ...prev, task: taskId, expanded: keep ? true : undefined };
}

/** The search with no task open. The window goes with the task: it is never left set on its own. */
export function withClosedTask<T extends TaskSearch>(prev: T): T {
  return { ...prev, task: undefined, expanded: undefined };
}

/** The open task in the window (true) or docked (false). With no task open there is nothing to expand. */
export function withExpanded<T extends TaskSearch>(prev: T, expanded: boolean): T {
  return { ...prev, expanded: expanded && prev.task !== undefined ? true : undefined };
}

/** Whether the search shows the task window: an open task, expanded. */
export function isTaskWindowSearch(search: TaskSearch): boolean {
  return search.task !== undefined && search.expanded === true;
}
