import type { TaskStatus } from "@taskboard/contracts";

/** What a draggable card or a droppable cell carries in its dnd-kit `data`. */
export interface DragData {
  type: "task" | "cell";
  projectId: string;
  status: TaskStatus;
}

export function readDragData(value: unknown): DragData | null {
  if (typeof value !== "object" || value === null) return null;
  const { type, projectId, status } = value as Record<string, unknown>;
  if ((type !== "task" && type !== "cell") || typeof projectId !== "string" || typeof status !== "string") return null;
  return { type, projectId, status: status as TaskStatus };
}

export const cellKey = (projectId: string, status: TaskStatus) => `${projectId}:${status}`;
export const cellDroppableId = (projectId: string, status: TaskStatus) => `cell:${projectId}:${status}`;

export type DropResult =
  | { kind: "invalid" }
  | { kind: "noop" }
  | { kind: "move"; status: TaskStatus; beforeId?: string; afterId?: string };

export interface DropInput {
  task: { id: string; projectId: string; status: TaskStatus };
  target: { projectId: string; status: TaskStatus };
  /** Ids of the target cell as rendered, in order. May include the dragged task. */
  cellTaskIds: ReadonlyArray<string>;
  /** The card under the pointer, or null when dropped on the cell itself. */
  overTaskId: string | null;
  /** For cross-cell drops: whether the dragged card's centre is below the hovered card's centre. */
  placeAfter: boolean;
}

/**
 * Turns a drop into a move request. Tasks never change project by dragging. Within a cell,
 * the order follows sortable semantics (the card takes the hovered card's slot); across cells
 * the card lands before/after the hovered card, or at the end of the cell. Done is ordered by
 * completion time, so reordering inside Done does nothing.
 */
export function computeDrop(input: DropInput): DropResult {
  const { task, target, cellTaskIds, overTaskId, placeAfter } = input;
  if (target.projectId !== task.projectId) return { kind: "invalid" };

  if (target.status === task.status) {
    if (task.status === "done") return { kind: "noop" };
    if (overTaskId === null || overTaskId === task.id) return { kind: "noop" };
    const from = cellTaskIds.indexOf(task.id);
    const to = cellTaskIds.indexOf(overTaskId);
    if (from < 0 || to < 0) return { kind: "noop" };
    const reordered = [...cellTaskIds];
    reordered.splice(from, 1);
    reordered.splice(to, 0, task.id);
    return neighbours(target.status, reordered, to);
  }

  const others = cellTaskIds.filter((id) => id !== task.id);
  const overIndex = overTaskId === null ? -1 : others.indexOf(overTaskId);
  if (overIndex < 0) {
    const last = others.at(-1);
    return last ? { kind: "move", status: target.status, afterId: last } : { kind: "move", status: target.status };
  }
  return placeAfter
    ? { kind: "move", status: target.status, afterId: others[overIndex] }
    : { kind: "move", status: target.status, beforeId: others[overIndex] };
}

function neighbours(status: TaskStatus, ordered: ReadonlyArray<string>, index: number): DropResult {
  const afterId = ordered[index - 1];
  if (afterId !== undefined) return { kind: "move", status, afterId };
  const beforeId = ordered[index + 1];
  if (beforeId !== undefined) return { kind: "move", status, beforeId };
  return { kind: "noop" };
}
