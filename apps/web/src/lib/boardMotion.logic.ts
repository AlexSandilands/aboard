/**
 * The View Transition type for a board navigation with smooth board motion: `panel-open` when a task opens with none
 * open, `panel-close` when the last one closes, and null otherwise (switching tasks keeps the panel where it is).
 */
export function panelTransitionType(fromTask: unknown, toTask: unknown): "panel-open" | "panel-close" | null {
  const was = typeof fromTask === "string" && fromTask !== "";
  const is = typeof toTask === "string" && toTask !== "";
  if (!was && is) return "panel-open";
  if (was && !is) return "panel-close";
  return null;
}
