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
    // Notifications and suggestions aren't part of the board snapshot; useBoardEvents refreshes their own caches.
    case "task.detail_changed":
    case "notification.created":
    case "notifications.changed":
    case "suggestions.changed":
    case "providers.changed":
    // A restore replaced the whole board; useBoardEvents refetches everything, the snapshot included.
    case "board.reset":
      return board;
  }
}

/**
 * Whether applying the event can move, add or remove cards or resize them, so the board should
 * remember where cards are first. A task edit that changes nothing a card shows doesn't.
 */
export function eventMovesCards(board: BoardSnapshot, event: BoardEvent): boolean {
  switch (event.type) {
    case "task.upserted": {
      const task = event.task;
      const before = board.tasks.find((t) => t.id === task.id);
      if (!before) return !task.archivedAt;
      return (
        !!task.archivedAt !== !!before.archivedAt ||
        task.status !== before.status ||
        task.position !== before.position ||
        task.projectId !== before.projectId ||
        task.parent?.id !== before.parent?.id ||
        task.priority !== before.priority ||
        task.title !== before.title ||
        task.labels.join("\n") !== before.labels.join("\n")
      );
    }
    case "task.deleted":
    case "project.upserted":
    case "project.deleted":
      return true;
    default:
      return false;
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
      // The server stamps every move as an update, so a column sorted by Recently updated puts the card where it
      // will stay rather than jumping once the server's event lands.
      const now = new Date().toISOString();
      if (to.status === t.status) return { ...t, position, updatedAt: now };
      // Leaving its column reopens a closed task; the server clears the resolution the same way.
      // statusChangedAt puts it on top of Done, which is newest-first.
      return {
        ...t,
        status: to.status,
        position,
        updatedAt: now,
        statusChangedAt: now,
        resolution: null,
        resolvedBy: null,
      };
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
  // updatedAt goes back too, unless an event has stamped a newer one since.
  const updatedAt = task.updatedAt === moved.updatedAt ? original.updatedAt : task.updatedAt;
  const restored = { ...task, status, position, updatedAt, statusChangedAt, resolution, resolvedBy };
  return { ...board, tasks: board.tasks.map((t) => (t === task ? restored : t)) };
}
