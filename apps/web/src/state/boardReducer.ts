import type { BoardEvent, BoardSnapshot, TaskStatus, TaskSummary } from "@repo/contracts";
import { generateKeyBetween } from "fractional-indexing";

/** Applies a server BoardEvent to the cached board snapshot. Pure; returns the same object when nothing changed. */
export function applyBoardEvent(board: BoardSnapshot, event: BoardEvent): BoardSnapshot {
  switch (event.type) {
    case "project.upserted": {
      const exists = board.projects.some((p) => p.id === event.project.id);
      if (event.project.archivedAt) {
        // An archived lane leaves the board with its tasks; unarchiving republishes them.
        return {
          ...board,
          projects: board.projects.filter((p) => p.id !== event.project.id),
          tasks: board.tasks.filter((t) => t.projectId !== event.project.id),
        };
      }
      const projects = exists
        ? board.projects.map((p) => (p.id === event.project.id ? event.project : p))
        : [...board.projects, event.project];
      return { ...board, projects: sortByPosition(projects) };
    }
    case "project.deleted":
      return {
        ...board,
        projects: board.projects.filter((p) => p.id !== event.projectId),
        tasks: board.tasks.filter((t) => t.projectId !== event.projectId),
      };
    case "task.upserted": {
      const task = event.task;
      const others = board.tasks.filter((t) => t.id !== task.id);
      return { ...board, tasks: task.archivedAt ? others : [...others, task] };
    }
    case "task.deleted":
      return { ...board, tasks: board.tasks.filter((t) => t.id !== event.taskId) };
    case "integrations.changed":
      return { ...board, integrations: { ...board.integrations, t3: event.t3 } };
    case "labels.colors_changed":
      return { ...board, labelColors: event.labelColors };
    case "autopilot.changed":
      return { ...board, autopilot: event.autopilot };
    case "task.detail_changed":
      return board;
  }
}

function sortByPosition<T extends { position: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
}

/** Tasks for one lane cell (project × status), ordered by position. */
export function cellTasks(tasks: ReadonlyArray<TaskSummary>, projectId: string, status: TaskStatus): TaskSummary[] {
  return sortByPosition(tasks.filter((t) => t.projectId === projectId && t.status === status));
}

/**
 * Optimistically moves a task to `status` placed before `beforeId` / after `afterId`
 * (both within the destination cell). The server's task.upserted event replaces the result.
 */
export function optimisticMove(
  board: BoardSnapshot,
  taskId: string,
  to: { status: TaskStatus; beforeId?: string | null; afterId?: string | null },
): BoardSnapshot {
  const task = board.tasks.find((t) => t.id === taskId);
  if (!task) return board;
  const cell = cellTasks(board.tasks, task.projectId, to.status).filter((t) => t.id !== taskId);
  // Resolve the neighbours the same way the server's positionAmong does: before wins, else after, else append.
  const beforeIndex = to.beforeId ? cell.findIndex((t) => t.id === to.beforeId) : -1;
  const afterIndex = to.afterId ? cell.findIndex((t) => t.id === to.afterId) : -1;
  const [lo, hi] =
    beforeIndex >= 0
      ? [cell[beforeIndex - 1], cell[beforeIndex]]
      : afterIndex >= 0
        ? [cell[afterIndex], cell[afterIndex + 1]]
        : [cell.at(-1), undefined];
  let position: string;
  try {
    position = generateKeyBetween(lo?.position ?? null, hi?.position ?? null);
  } catch {
    position = task.position; // malformed keys: keep order until the server responds
  }
  return {
    ...board,
    tasks: board.tasks.map((t) => {
      if (t.id !== taskId) return t;
      if (to.status === t.status) return { ...t, position };
      // Leaving its column reopens a closed task; the server clears the resolution the same way.
      // statusChangedAt puts it on top of Done, which is newest-first.
      const statusChangedAt = new Date().toISOString();
      return { ...t, status: to.status, position, statusChangedAt, resolution: null, resolvedBy: null };
    }),
  };
}

/** optimisticMove for a move request, which may leave the status unchanged. */
export const applyMove = (
  board: BoardSnapshot,
  {
    id,
    status,
    beforeId,
    afterId,
  }: { id: string; status?: TaskStatus; beforeId?: string | null; afterId?: string | null },
) =>
  optimisticMove(board, id, {
    status: status ?? board.tasks.find((t) => t.id === id)?.status ?? "backlog",
    beforeId,
    afterId,
  });

/** True when the task is back where it was before its move, e.g. a cancelled fetch restored the cache. */
export function moveWasReverted(board: BoardSnapshot, original: TaskSummary): boolean {
  const task = board.tasks.find((t) => t.id === original.id);
  return task?.status === original.status && task.position === original.position;
}

/**
 * Undoes a failed optimistic move on the task as it is now, so newer fields from events survive.
 * Leaves the task alone once something newer has replaced the optimistic placement.
 */
export function rollbackMove(board: BoardSnapshot, original: TaskSummary, moved: TaskSummary): BoardSnapshot {
  const task = board.tasks.find((t) => t.id === original.id);
  if (!task || task.status !== moved.status || task.position !== moved.position) return board;
  const { status, position, statusChangedAt, resolution, resolvedBy } = original;
  const restored = { ...task, status, position, statusChangedAt, resolution, resolvedBy };
  return { ...board, tasks: board.tasks.map((t) => (t === task ? restored : t)) };
}
