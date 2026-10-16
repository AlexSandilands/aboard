import { randomUUID } from "node:crypto";
import {
  inQuietHours,
  type InboxNotification,
  type NotificationKind,
  type NotificationList,
  type NotifyInput,
} from "@repo/contracts";
import type { Repos } from "../db/repos/index.ts";
import { notFound } from "../errors.ts";
import { loadAutopilotEngine } from "./autopilot.ts";
import type { Core } from "./core.ts";
import { loadSettings } from "./settings.ts";

/** Notifications older than this are dropped. */
export const NOTIFICATION_RETENTION_DAYS = 30;
const LIST_LIMIT = 100;

const cutoff = (now: Date): string => new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * 86_400_000).toISOString();

/** How many notifications are unread, among those kept. Also what the SSE events carry. */
export const unreadNotifications = (repos: Repos, now: Date): number => repos.notifications.unread(cutoff(now));

/** The attention inbox (docs/features/notifications.md). Producers call `notify`; the rest serves the inbox. */
export interface NotificationsService {
  /**
   * Records a state change for the inbox, unless its kind is switched off or its dedupe key already has one (null
   * then). Joins an open write, so a producer's change and its notification commit together. A notification made
   * during quiet hours is recorded but sent without a popup.
   */
  notify(input: NotifyInput): InboxNotification | null;
  /** Newest first, with the unread count across all of them (not just this page). */
  list(opts?: { kind?: NotificationKind; limit?: number }): NotificationList;
  markRead(id: string): InboxNotification;
  markAllRead(): number;
}

export function createNotificationsService(core: Core): NotificationsService {
  const { repos } = core;

  const list: NotificationsService["list"] = (opts = {}) => {
    const now = core.now();
    return {
      items: repos.notifications.list({
        since: cutoff(now),
        ...(opts.kind ? { kind: opts.kind } : {}),
        limit: opts.limit ?? LIST_LIMIT,
      }),
      unread: unreadNotifications(repos, now),
    };
  };

  return {
    notify(input) {
      const settings = loadSettings(repos).notifications;
      if (!settings.kinds[input.kind]) return null;
      return core.write((fx) => {
        const now = core.now();
        // Pruned here rather than on a timer: nothing is added without passing through, and reads skip old rows.
        repos.notifications.prune(cutoff(now));
        if (repos.notifications.hasKey(input.dedupeKey)) return null;
        const notification: InboxNotification = {
          id: randomUUID(),
          kind: input.kind,
          taskId: input.taskId ?? null,
          title: input.title,
          body: input.body,
          createdAt: now.toISOString(),
          readAt: null,
        };
        repos.notifications.insert(notification, input.dedupeKey);
        const quiet =
          settings.muteInQuietHours &&
          inQuietHours(loadAutopilotEngine(repos).quietHours, now.getHours() * 60 + now.getMinutes());
        fx.notified(notification, !quiet);
        return notification;
      });
    },

    list,

    markRead(id) {
      return core.write((fx) => {
        const existing = repos.notifications.get(id);
        if (!existing) throw notFound("Notification", id);
        if (!repos.notifications.markRead(id, core.now().toISOString())) return existing;
        fx.notificationsChanged();
        return repos.notifications.get(id)!;
      });
    },

    markAllRead() {
      return core.write((fx) => {
        const changed = repos.notifications.markAllRead(core.now().toISOString());
        if (changed > 0) fx.notificationsChanged();
        return changed;
      });
    },
  };
}
