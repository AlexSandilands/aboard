import type { BoardEvent, InboxNotification, T3IntegrationStatus } from "@repo/contracts";
import { generateKeyBetween } from "fractional-indexing";
import type { EventBus } from "../bus.ts";
import { nowIso, transaction, type Db } from "../db/database.ts";
import type { Repos } from "../db/repos/index.ts";
import { AppError } from "../errors.ts";
import { loadAutopilotStatus } from "./autopilot.ts";
import { unreadNotifications } from "./notifications.ts";
import { assembleSummaries } from "./summaries.ts";

/** Change notes collected during a write; turned into BoardEvents after commit. */
export interface Effects {
  /** The task's card changed (publishes task.upserted and task.detail_changed). */
  task(id: string): void;
  /** Only the task's detail view changed. */
  detail(id: string): void;
  project(id: string): void;
  projectDeleted(id: string): void;
  taskDeleted(id: string): void;
  /** Label colour overrides changed (publishes labels.colors_changed). */
  labelColors(): void;
  /** Autopilot runs, settings or pause changed (publishes autopilot.changed). */
  autopilot(): void;
  /** A notification was recorded; `popup` is false when quiet hours keep it to the inbox (publishes notification.created). */
  notified(notification: InboxNotification, popup: boolean): void;
  /** Notifications were read (publishes notifications.changed). */
  notificationsChanged(): void;
  /** Appends a task_events row and marks the task's card changed. */
  log(taskId: string, actor: string, type: string, payload?: Record<string, unknown>): void;
}

interface Pending {
  tasks: Set<string>;
  details: Set<string>;
  projects: Set<string>;
  deletedProjects: Set<string>;
  deletedTasks: Set<string>;
  labelColors: boolean;
  autopilot: boolean;
  notified: Array<{ notification: InboxNotification; popup: boolean }>;
  notificationsChanged: boolean;
}

export interface Core {
  db: Db;
  repos: Repos;
  bus: EventBus;
  t3Status: () => T3IntegrationStatus;
  /** The clock, swapped in by tests. */
  now: () => Date;
  /**
   * Runs `fn` in a transaction and publishes the collected BoardEvents after it commits.
   * Nested calls join the outer write; nothing is published if the transaction throws.
   */
  write<T>(fn: (fx: Effects) => T): T;
}

/** Builds the shared write/flush machinery used by every service. */
export function createCore(deps: {
  db: Db;
  repos: Repos;
  bus: EventBus;
  t3Status: () => T3IntegrationStatus;
  now?: () => Date;
}): Core {
  const { db, repos, bus } = deps;
  const now = deps.now ?? (() => new Date());
  let pending: Pending | null = null;
  /** The unread count last published, to tell whether deleting tasks changed it. */
  let lastUnread = unreadNotifications(repos, now());

  const effectsFor = (p: Pending): Effects => ({
    task: (id) => p.tasks.add(id),
    detail: (id) => p.details.add(id),
    project: (id) => p.projects.add(id),
    projectDeleted: (id) => p.deletedProjects.add(id),
    taskDeleted: (id) => p.deletedTasks.add(id),
    labelColors: () => {
      p.labelColors = true;
    },
    autopilot: () => {
      p.autopilot = true;
    },
    notified: (notification, popup) => {
      p.notified.push({ notification, popup });
    },
    notificationsChanged: () => {
      p.notificationsChanged = true;
    },
    log: (taskId, actor, type, payload) => {
      repos.events.append(taskId, nowIso(), actor, type, payload);
      p.tasks.add(taskId);
    },
  });

  const flush = (p: Pending): void => {
    const events: BoardEvent[] = [];
    for (const taskId of p.deletedTasks) events.push({ type: "task.deleted", taskId });
    for (const projectId of p.deletedProjects) events.push({ type: "project.deleted", projectId });
    for (const id of p.projects) {
      if (p.deletedProjects.has(id)) continue;
      const project = repos.projects.get(id);
      if (project) events.push({ type: "project.upserted", project });
    }
    const upserts = [...p.tasks].filter((id) => !p.deletedTasks.has(id));
    if (upserts.length > 0) {
      for (const { summary } of assembleSummaries(repos, repos.tasks.getMany(upserts)).values()) {
        events.push({ type: "task.upserted", task: summary }, { type: "task.detail_changed", taskId: summary.id });
        // An epic's detail lists its children's cards.
        if (summary.parent && !p.tasks.has(summary.parent.id)) p.details.add(summary.parent.id);
      }
    }
    for (const taskId of p.details) {
      if (!p.tasks.has(taskId) && !p.deletedTasks.has(taskId)) events.push({ type: "task.detail_changed", taskId });
    }
    if (p.labelColors) events.push({ type: "labels.colors_changed", labelColors: repos.labels.colors() });
    if (p.autopilot) events.push({ type: "autopilot.changed", autopilot: loadAutopilotStatus(repos) });
    // A deleted task takes its notifications with it, which only matters when some of them were unread.
    if (p.notified.length > 0 || p.notificationsChanged || p.deletedTasks.size > 0) {
      const unread = unreadNotifications(repos, now());
      for (const { notification, popup } of p.notified) {
        events.push({ type: "notification.created", notification, unread, popup });
      }
      if (p.notified.length === 0 && (p.notificationsChanged || unread !== lastUnread)) {
        events.push({ type: "notifications.changed", unread });
      }
      lastUnread = unread;
    }
    for (const event of events) bus.publish(event);
  };

  return {
    db,
    repos,
    bus,
    t3Status: deps.t3Status,
    now,
    write<T>(fn: (fx: Effects) => T): T {
      if (pending) return fn(effectsFor(pending));
      const p: Pending = {
        tasks: new Set(),
        details: new Set(),
        projects: new Set(),
        deletedProjects: new Set(),
        deletedTasks: new Set(),
        labelColors: false,
        autopilot: false,
        notified: [],
        notificationsChanged: false,
      };
      pending = p;
      let result: T;
      try {
        result = transaction(db, () => fn(effectsFor(p)));
      } finally {
        pending = null;
      }
      flush(p);
      return result;
    },
  };
}

/**
 * Fractional key for placing an item among `ordered` siblings (which must exclude the item).
 * `beforeId` places it directly before that sibling, `afterId` directly after; neither appends.
 */
export function positionAmong(
  ordered: ReadonlyArray<{ id: string; position: string }>,
  place: { beforeId?: string | null; afterId?: string | null },
): string {
  const indexOf = (id: string) => {
    const index = ordered.findIndex((item) => item.id === id);
    if (index < 0) throw new AppError("VALIDATION", `Cannot place relative to ${id}: not a sibling in the target list`);
    return index;
  };
  let lo: string | null;
  let hi: string | null;
  if (place.beforeId) {
    const index = indexOf(place.beforeId);
    lo = ordered[index - 1]?.position ?? null;
    hi = ordered[index]!.position;
  } else if (place.afterId) {
    const index = indexOf(place.afterId);
    lo = ordered[index]!.position;
    hi = ordered[index + 1]?.position ?? null;
  } else {
    lo = ordered.at(-1)?.position ?? null;
    hi = null;
  }
  return generateKeyBetween(lo, hi);
}
