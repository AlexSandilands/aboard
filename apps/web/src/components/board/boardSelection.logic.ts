import { planTaskProblem, type TaskSummary } from "@repo/contracts";

// Picking several cards: Ctrl/⌘-click toggles any card, a plain click or Esc clears the pick. The pick is what the
// card menu's bulk actions apply to and what the planning picker starts with ticked, where only the cards a planning
// session can take count (see planTaskProblem). See docs/features/agent-handoff.md.

/** Whether a click toggles the card instead of opening it: Ctrl, or ⌘ on a Mac. */
export const isPickClick = (event: { ctrlKey: boolean; metaKey: boolean }): boolean => event.ctrlKey || event.metaKey;

/** Whether a planning session can take the task: the cards the lane's planning button and the picker count. */
export const isPlannable = (task: TaskSummary): boolean => planTaskProblem(task) === null;

/** `picked` with `id` added, or removed when it was there. */
export const togglePicked = (picked: readonly string[], id: string): string[] =>
  picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id];

/** The project's tasks a planning session can take, in number order: what the planning picker lists. */
export const plannableTasks = (tasks: readonly TaskSummary[], projectId: string): TaskSummary[] =>
  tasks.filter((t) => t.projectId === projectId && isPlannable(t)).sort((a, b) => a.number - b.number);

/** The picked ids among `plannable`, in their order: what the picker starts with ticked. */
export const pickedAmong = (picked: readonly string[], plannable: readonly TaskSummary[]): string[] =>
  plannable.filter((t) => picked.includes(t.id)).map((t) => t.id);
