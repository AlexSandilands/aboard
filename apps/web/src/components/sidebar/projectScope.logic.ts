/** The value of the menu's "All projects" row, which stands for an empty scope. */
export const ALL_PROJECTS_VALUE = "all";

/**
 * The project ids the scope becomes when the multi-select reports `next` after showing `shown`. While no project is
 * ticked the menu shows only the "All projects" row, so: picking that row when it isn't shown clears the scope, and
 * picking a project while it is shown drops it and ticks just that project.
 */
export function nextProjectScope(shown: ReadonlyArray<string>, next: ReadonlyArray<string>): string[] {
  const pickedAll = next.includes(ALL_PROJECTS_VALUE);
  const wasAll = shown.includes(ALL_PROJECTS_VALUE);
  return pickedAll && !wasAll ? [] : next.filter((value) => value !== ALL_PROJECTS_VALUE);
}
