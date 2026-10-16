import type { TaskStatus, TaskSummary } from "@repo/contracts";
import { findRow, replaceRowCells, STATUS_ORDER, type Lane } from "./board.logic";

/** What a draggable card or a droppable cell carries in its dnd-kit `data`. */
export interface DragData {
  type: "task" | "cell";
  /** The card's row: its epic's band, or its project's loose cards (see Row in board.logic). */
  rowId: string;
  status: TaskStatus;
}

export function readDragData(value: unknown): DragData | null {
  if (typeof value !== "object" || value === null) return null;
  const { type, rowId, status } = value as Record<string, unknown>;
  if ((type !== "task" && type !== "cell") || typeof rowId !== "string" || typeof status !== "string") return null;
  return { type, rowId, status: status as TaskStatus };
}

export const cellKey = (rowId: string, status: TaskStatus) => `${rowId}:${status}`;
export function parseCellKey(key: unknown): { rowId: string; status: TaskStatus } | null {
  if (typeof key !== "string") return null;
  const split = key.lastIndexOf(":");
  const status = key.slice(split + 1);
  if (split <= 0 || !STATUS_ORDER.includes(status as TaskStatus)) return null;
  return { rowId: key.slice(0, split), status: status as TaskStatus };
}
export const cellDroppableId = (rowId: string, status: TaskStatus) => `cell:${rowId}:${status}`;

/** The cell a dragged card hovers, other than its own; `invalid` when it's in another row. */
export interface OverCell {
  rowId: string;
  status: TaskStatus;
  invalid: boolean;
}

/** Where the dragged card shows while it hovers another column of its own row. */
export interface DragPlacement {
  taskId: string;
  rowId: string;
  status: TaskStatus;
  /** Index in the target cell's rendered cards, not counting the dragged card. */
  index: number;
}

export interface PlacementInput {
  task: { id: string; rowId: string; status: TaskStatus };
  target: { rowId: string; status: TaskStatus };
  /** Ids of the hovered cell as rendered, in order. */
  cellTaskIds: ReadonlyArray<string>;
  /** The card under the pointer, or null when hovering the cell itself. */
  overTaskId: string | null;
  /** Whether the dragged card's centre is below the hovered card's centre. */
  placeAfter: boolean;
}

/**
 * Where to open a gap for the dragged card. Null means no preview: the card's own column (sortable
 * handles reordering there) or another row (tasks never change project or epic by dragging).
 * Done is newest-first on the server too, so a card dragged into Done always shows at the top.
 */
export function previewPlacement(input: PlacementInput): DragPlacement | null {
  const { task, target, cellTaskIds, overTaskId, placeAfter } = input;
  if (target.rowId !== task.rowId || target.status === task.status) return null;
  const placement = { taskId: task.id, rowId: target.rowId, status: target.status };
  if (target.status === "done") return { ...placement, index: 0 };
  const others = cellTaskIds.filter((id) => id !== task.id);
  const overIndex = overTaskId === null ? -1 : others.indexOf(overTaskId);
  return { ...placement, index: overIndex < 0 ? others.length : overIndex + (placeAfter ? 1 : 0) };
}

export const samePlacement = (a: DragPlacement | null, b: DragPlacement | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.taskId === b.taskId &&
    a.rowId === b.rowId &&
    a.status === b.status &&
    a.index === b.index);

/**
 * The lanes as shown mid-drag, and right after a drop until the cache has the move: the dragged
 * card moved into its placement. Only the lane, the row and the cells involved are new objects, so
 * every other memoized lane, band and cell skips rendering.
 */
export function previewMove(lanes: ReadonlyArray<Lane>, placement: DragPlacement | null): ReadonlyArray<Lane> {
  if (!placement) return lanes;
  const row = findRow(lanes, placement.rowId);
  if (!row) return lanes;
  const from = STATUS_ORDER.find((status) => row.cells[status].some((t) => t.id === placement.taskId));
  if (!from) return lanes;
  const source = row.cells[from];
  const task = source.find((t) => t.id === placement.taskId)!;
  const rest = (from === placement.status ? source : row.cells[placement.status]).filter((t) => t !== task);
  const index = Math.min(placement.index, rest.length);
  if (from === placement.status && source[index] === task) return lanes;
  const cells: Record<TaskStatus, ReadonlyArray<TaskSummary>> = { ...row.cells };
  cells[from] = source.filter((t) => t !== task);
  cells[placement.status] = [...rest.slice(0, index), task, ...rest.slice(index)];
  return replaceRowCells(lanes, row.id, cells);
}

/**
 * Where a dropped card ends up once the move lands: its slot among the target cell's other
 * rendered cards. Held as the placement until the cache has the move, which arrives a tick later.
 */
export function placementAfterDrop(
  task: { id: string; rowId: string },
  cellTaskIds: ReadonlyArray<string>,
  move: Extract<DropResult, { kind: "move" }>,
): DragPlacement {
  const others = cellTaskIds.filter((id) => id !== task.id);
  const after = move.afterId === undefined ? -1 : others.indexOf(move.afterId);
  const before = move.beforeId === undefined ? -1 : others.indexOf(move.beforeId);
  const index = move.status === "done" ? 0 : after >= 0 ? after + 1 : before >= 0 ? before : others.length;
  return { taskId: task.id, rowId: task.rowId, status: move.status, index };
}

export type DropResult =
  | { kind: "invalid" }
  | { kind: "noop" }
  | { kind: "move"; status: TaskStatus; beforeId?: string; afterId?: string };

export interface DropInput {
  task: { id: string; rowId: string; status: TaskStatus };
  target: { rowId: string; status: TaskStatus };
  /**
   * Ids of the target cell as the user saw them at the drop, in order: the drag preview, so a card
   * brought in from another column is already in it. Leave out cards that can't anchor a move.
   */
  cellTaskIds: ReadonlyArray<string>;
  /** The card under the pointer, or null when dropped on the cell itself. */
  overTaskId: string | null;
}

/**
 * Turns a drop into a move request. Tasks never change row (project or epic) by dragging. The card takes the
 * hovered card's slot (sortable semantics) in the order the user saw, or stays where the preview
 * put it when dropped on the cell. Done is ordered by completion time, so a card moved there needs
 * no neighbours and reordering inside Done does nothing.
 */
export function computeDrop(input: DropInput): DropResult {
  const { task, target, cellTaskIds, overTaskId } = input;
  if (target.rowId !== task.rowId) return { kind: "invalid" };

  const ordered = cellTaskIds.includes(task.id) ? [...cellTaskIds] : [...cellTaskIds, task.id];
  const from = ordered.indexOf(task.id);
  const overIndex = overTaskId === null || overTaskId === task.id ? -1 : ordered.indexOf(overTaskId);
  const to = overIndex < 0 ? from : overIndex;
  ordered.splice(from, 1);
  ordered.splice(to, 0, task.id);

  if (target.status === task.status) {
    if (task.status === "done" || to === from) return { kind: "noop" };
    return neighbours(target.status, ordered, to) ?? { kind: "noop" };
  }
  if (target.status === "done") return { kind: "move", status: "done" };
  return neighbours(target.status, ordered, to) ?? { kind: "move", status: target.status };
}

function neighbours(status: TaskStatus, ordered: ReadonlyArray<string>, index: number): DropResult | null {
  const afterId = ordered[index - 1];
  if (afterId !== undefined) return { kind: "move", status, afterId };
  const beforeId = ordered[index + 1];
  if (beforeId !== undefined) return { kind: "move", status, beforeId };
  return null;
}

/**
 * Whether a move leaves the card past the first `previewCount` cards of its new cell, where a
 * collapsed cell would hide it. `fullCellTaskIds` is the whole cell in order, not just the rendered
 * cards. Done orders by completion time, so a card moved there always lands first.
 */
export function landsPastPreview(
  result: DropResult,
  taskId: string,
  fullCellTaskIds: ReadonlyArray<string>,
  previewCount: number,
): boolean {
  if (result.kind !== "move" || result.status === "done") return false;
  const others = fullCellTaskIds.filter((id) => id !== taskId);
  const index = result.afterId
    ? others.indexOf(result.afterId) + 1
    : result.beforeId
      ? others.indexOf(result.beforeId)
      : 0;
  return index >= previewCount;
}
