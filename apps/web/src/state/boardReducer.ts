import type { BoardEvent, BoardSnapshot, TaskStatus, TaskSummary } from "@taskboard/contracts";
import { generateKeyBetween } from "fractional-indexing";

/** Applies a server BoardEvent to the cached board snapshot. Pure; returns the same object when nothing changed. */
export function applyBoardEvent(board: BoardSnapshot, event: BoardEvent): BoardSnapshot {
  switch (event.type) {
    case "project.upserted": {
      const exists = board.projects.some((p) => p.id === event.project.id);
      const projects = event.project.archivedAt
        ? board.projects.filter((p) => p.id !== event.project.id)
        : exists
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
  // Resolve the neighbours the same way the server does: after wins, else before, else append.
  const afterIndex = to.afterId ? cell.findIndex((t) => t.id === to.afterId) : -1;
  const beforeIndex = to.beforeId ? cell.findIndex((t) => t.id === to.beforeId) : -1;
  const [lo, hi] =
    afterIndex >= 0
      ? [cell[afterIndex], cell[afterIndex + 1]]
      : beforeIndex >= 0
        ? [cell[beforeIndex - 1], cell[beforeIndex]]
        : [cell.at(-1), undefined];
  let position: string;
  try {
    position = generateKeyBetween(lo?.position ?? null, hi?.position ?? null);
  } catch {
    position = task.position; // malformed keys: keep order until the server responds
  }
  return {
    ...board,
    tasks: board.tasks.map((t) => (t.id === taskId ? { ...t, status: to.status, position } : t)),
  };
}
