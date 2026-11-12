/**
 * The View Transition type for a board navigation with smooth board motion: `panel-open` when a task opens with none
 * open, `panel-close` when the last one closes, and null otherwise (switching tasks keeps the panel where it is).
 *
 * A task opened straight into the task window (`toExpanded`) gets none either: the page shows snapshots for the length
 * of a transition, and the window, which is in none of them, would stay unseen until it ended. Its panel appears in
 * place behind the window instead.
 */
export function panelTransitionType(
  fromTask: unknown,
  toTask: unknown,
  toExpanded?: unknown,
): "panel-open" | "panel-close" | null {
  const was = typeof fromTask === "string" && fromTask !== "";
  const is = typeof toTask === "string" && toTask !== "";
  if (!was && is) return toExpanded === true ? null : "panel-open";
  if (was && !is) return "panel-close";
  return null;
}
