import type { TaskDetail } from "@repo/contracts";

/**
 * More-menu actions that can be pinned beside the title, in menu order. Submenus (move, close as)
 * need a second pick and delete is destructive, so neither is a sensible one-click button.
 */
export const PINNABLE_ACTIONS = ["plan", "reopen", "archive", "copy-link", "copy-reference"] as const;

export type PinnableAction = (typeof PINNABLE_ACTIONS)[number];

type TaskState = Pick<TaskDetail, "resolution" | "archivedAt" | "status" | "kind">;

/** Pins in menu order, with duplicates and unknown ids (e.g. from older storage) dropped. */
export function normalizePins(pins: ReadonlyArray<unknown>): PinnableAction[] {
  return PINNABLE_ACTIONS.filter((id) => pins.includes(id));
}

export function togglePin(pins: ReadonlyArray<unknown>, id: PinnableAction): PinnableAction[] {
  const current = normalizePins(pins);
  return current.includes(id) ? current.filter((pin) => pin !== id) : normalizePins([...current, id]);
}

/** Pinnable actions the More menu lists for this task. */
export function menuActions(task: TaskState): PinnableAction[] {
  // An epic has no plan, and its status follows its tasks, so there is nothing to reopen.
  if (task.kind === "epic") return PINNABLE_ACTIONS.filter((id) => id !== "plan" && id !== "reopen");
  return PINNABLE_ACTIONS.filter((id) => id !== "reopen" || task.resolution !== null);
}

/** Pinned buttons to show beside the title, in menu order. */
export function pinnedButtons(pins: ReadonlyArray<unknown>, task: TaskState): PinnableAction[] {
  const menu = menuActions(task);
  // The top bar already offers Archive on finished tasks; a pinned copy would sit right below it.
  const topBarArchive = task.status === "done" && task.archivedAt === null && task.kind !== "epic";
  return normalizePins(pins).filter((id) => menu.includes(id) && !(id === "archive" && topBarArchive));
}
