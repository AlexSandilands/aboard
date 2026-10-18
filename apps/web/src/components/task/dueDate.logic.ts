import { dueState, type DueState } from "@repo/contracts";

/** The viewer's local calendar date as `YYYY-MM-DD`; a due date has no timezone, so "today" is whatever the viewer's clock says. */
export function localToday(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${String(now.getFullYear()).padStart(4, "0")}-${month}-${day}`;
}

/** Short text for a due date: "Nov 2", with the year when it isn't this one. */
export function dueDateLabel(dueDate: string, today: string = localToday()): string {
  const [year, month, day] = dueDate.split("-").map(Number) as [number, number, number];
  const sameYear = dueDate.slice(0, 4) === today.slice(0, 4);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Text colour for a due date: muted unless it is due today (amber) or overdue (red). */
export function dueStateClassName(state: DueState): string {
  return state === "overdue"
    ? "text-destructive-foreground"
    : state === "today"
      ? "text-warning-foreground"
      : "text-muted-foreground";
}

export function dueStateOf(dueDate: string, today: string = localToday()): DueState {
  return dueState(dueDate, today);
}

/** Words for the state, for screen readers and tooltips. */
export function dueStateText(state: DueState): string {
  return state === "overdue" ? "Overdue" : state === "today" ? "Due today" : "Due";
}
