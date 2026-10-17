import { planTaskProblem, type TaskSummary } from "@repo/contracts";

// Picking several cards to plan together: Ctrl/⌘-click toggles a card, a plain click or Esc clears the pick. Only
// cards a planning session can take are pickable (see planTaskProblem). See docs/features/agent-handoff.md.

/** Whether a click toggles the card instead of opening it: Ctrl, or ⌘ on a Mac. */
export const isPickClick = (event: { ctrlKey: boolean; metaKey: boolean }): boolean => event.ctrlKey || event.metaKey;

export const canPickTask = (task: TaskSummary): boolean => planTaskProblem(task) === null;

/** `picked` with `id` added, or removed when it was there. */
export const togglePicked = (picked: readonly string[], id: string): string[] =>
  picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id];

/** The project's tasks a planning session can take, in number order: what the planning picker lists. */
export const plannableTasks = (tasks: readonly TaskSummary[], projectId: string): TaskSummary[] =>
  tasks.filter((t) => t.projectId === projectId && canPickTask(t)).sort((a, b) => a.number - b.number);

/** The picked ids among `plannable`, in their order: what the picker starts with ticked. */
export const pickedAmong = (picked: readonly string[], plannable: readonly TaskSummary[]): string[] =>
  plannable.filter((t) => picked.includes(t.id)).map((t) => t.id);
