import {
  AUTOPILOT_ACTOR,
  AUTOPILOT_UNBLOCK_DEPENDENTS,
  AUTOPILOT_UNSTICK,
  UNSTICK_STALE_PREFIX,
  UNSTICK_WAITING_PREFIX,
  implementingThread,
  type NotifyInput,
} from "@repo/contracts";
import type { Services } from "../services/types.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** How long an In Progress task is quiet before the user hears of it (the label of the `task_quiet` setting). */
export const QUIET_AFTER_MS = 24 * HOUR_MS;
/** How long a thread waits on the user before they hear of it (the label of the `thread_waited` setting). */
export const WAITING_AFTER_MS = 30 * MINUTE_MS;
/** How long after its last blocker finished a dependent still counts as just unblocked. */
const UNBLOCKED_RECENT_MS = 24 * HOUR_MS;

const duration = (ms: number): string => {
  const minutes = Math.floor(ms / MINUTE_MS);
  return minutes >= 120 ? `${Math.floor(minutes / 60)}h` : `${minutes}m`;
};

/**
 * The reminders the engine's tick sends to the inbox (docs/features/notifications.md): an In Progress task gone quiet,
 * a T3 thread that has waited on the user, a task whose last blocker finished. They need no agent and start nothing,
 * so they are notification settings, not automations; Pause all doesn't hold them back either (they only tell the
 * user), and quiet hours only keep their popups quiet. They come from the Unstick and Unblock dependents automations,
 * which lived in the catalogue until then, with the same detection and dedupe keys, so a state they had already
 * reported (a run under the same key) isn't reported again.
 *
 * A reminder also leaves a note on the task as the Autopilot actor. Autopilot's own entries aren't activity, or the
 * note would end the quiet period it reports. Dedupe keys carry the moment the quiet period or the wait began (or the
 * latest blocker finished), so each is reported once; the note is added only when the notification was. The key lives
 * in the notification, which is pruned after NOTIFICATION_RETENTION_DAYS, so a task that stays quiet or a thread that
 * keeps waiting for longer than that is reminded of once more, with another note, each time.
 */
export function sendReminders(services: Services, now: Date): void {
  const { kinds } = services.settings.get().notifications;
  /**
   * Sends one reminder, and adds the note when it was new. A state the retired automation already reported has a run
   * under the same key, and its notification may never have been stored (it was `autopilot_notice`, off by default),
   * so the runs count as seen too. Checking first keeps a reminder already sent from opening a write every pass.
   */
  const remind = (legacy: string, taskId: string, input: NotifyInput, note: string) => {
    if (services.notifications.has(input.dedupeKey) || services.autopilot.hasRun(legacy, input.dedupeKey, false))
      return;
    if (services.notifications.notify({ ...input, taskId })) services.tasks.addNote(taskId, note, AUTOPILOT_ACTOR);
  };
  const quiet = kinds.task_quiet;
  const waited = kinds.thread_waited;
  const unblocked = kinds.task_unblocked;
  if (!quiet && !waited && !unblocked) return;

  for (const project of services.projects.list()) {
    if (quiet || waited) {
      const inProgress = services.tasks
        .summaries({ projectId: project.id, status: "in_progress" })
        // A manual task is the user's own to-do: reminding them it is quiet is noise.
        .filter((t) => t.kind !== "epic" && !t.manual);
      for (const t of inProgress) {
        if (quiet) {
          const lastActivityAt = [services.tasks.lastActivityAt(t.id, AUTOPILOT_ACTOR), t.statusChangedAt]
            .filter((at): at is string => at !== null)
            .sort()
            .at(-1)!;
          const ms = now.getTime() - Date.parse(lastActivityAt);
          if (ms >= QUIET_AFTER_MS) {
            const message = `${UNSTICK_STALE_PREFIX} ${duration(ms)}`;
            remind(
              AUTOPILOT_UNSTICK,
              t.id,
              {
                kind: "task_quiet",
                title: `#${t.number} has gone quiet`,
                body: `${message}: “${t.title}”.`,
                dedupeKey: `stale:${t.id}:${lastActivityAt}`,
              },
              message,
            );
          }
        }
        const thread = implementingThread(t);
        const snapshot = thread?.snapshot;
        if (
          waited &&
          thread &&
          snapshot &&
          ["input", "approval"].includes(snapshot.status) &&
          snapshot.lastActivityAt
        ) {
          const ms = now.getTime() - Date.parse(snapshot.lastActivityAt);
          if (ms >= WAITING_AFTER_MS) {
            const message = `${UNSTICK_WAITING_PREFIX} ${duration(ms)}`;
            remind(
              AUTOPILOT_UNSTICK,
              t.id,
              {
                kind: "thread_waited",
                title: `#${t.number} is waiting for you`,
                body: `${message}: “${t.title}”.`,
                dedupeKey: `waiting:${thread.id}:${snapshot.lastActivityAt}`,
              },
              message,
            );
          }
        }
      }
    }

    if (unblocked) {
      const summaries = services.tasks.summaries({ projectId: project.id });
      const byId = new Map(summaries.map((t) => [t.id, t]));
      const since = now.getTime() - UNBLOCKED_RECENT_MS;
      for (const t of summaries) {
        if (
          t.kind === "epic" ||
          t.archivedAt !== null ||
          t.status === "done" ||
          t.blockedBy.length === 0 ||
          t.blocked
        ) {
          continue;
        }
        // Blockers in other projects aren't in the map.
        const blockers = t.blockedBy.map((b) => byId.get(b.id) ?? services.tasks.summary(b.id));
        const lastDoneAt = blockers
          .map((b) => b.statusChangedAt)
          .sort()
          .at(-1)!;
        // About something that just happened: not blockers finished long ago (when the setting is first switched on,
        // or a Done task is attached as a blocker).
        if (Date.parse(lastDoneAt) < since) continue;
        const names = blockers.map((b) => `#${b.number}${b.resolution === "wont_do" ? " (won't do)" : ""}`).join(", ");
        remind(
          AUTOPILOT_UNBLOCK_DEPENDENTS,
          t.id,
          {
            kind: "task_unblocked",
            title: `#${t.number} is unblocked`,
            body: `${names} finished, so “${t.title}” has nothing left blocking it.`,
            dedupeKey: `unblock:${t.id}:${lastDoneAt}`,
          },
          `Unblocked: ${names} finished`,
        );
      }
    }
  }
}
