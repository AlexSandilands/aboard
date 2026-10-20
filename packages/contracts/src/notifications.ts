import { z } from "zod";

// The attention inbox and desktop notifications (docs/features/notifications.md).

/** What a notification is about; each has its own switch in settings. */
export const NotificationKind = z.enum([
  "thread_waiting",
  "pr_checks_failing",
  "pr_changes_requested",
  "review_finished",
  "autopilot_failed",
  "autopilot_notice",
  "suggestion",
  "agent_request",
  "automation_draft",
]);
export type NotificationKind = z.infer<typeof NotificationKind>;

export const NOTIFICATION_KINDS: ReadonlyArray<{ kind: NotificationKind; label: string; description: string }> = [
  { kind: "thread_waiting", label: "Thread waiting", description: "A linked T3 Code thread needs input or approval" },
  { kind: "pr_checks_failing", label: "Checks failing", description: "A linked pull request's checks started failing" },
  {
    kind: "pr_changes_requested",
    label: "Changes requested",
    description: "A reviewer asked for changes on a linked pull request",
  },
  { kind: "review_finished", label: "Review finished", description: "A local review round was submitted" },
  { kind: "autopilot_failed", label: "Autopilot failed", description: "An Autopilot run failed or gave up" },
  { kind: "autopilot_notice", label: "Autopilot updates", description: "Other things Autopilot wants you to know" },
  { kind: "suggestion", label: "Suggested changes", description: "An agent suggested a change to a prompt or skill" },
  { kind: "agent_request", label: "Agent requests", description: "An agent asked you to look at a task" },
  {
    kind: "automation_draft",
    label: "Automation drafts",
    description: "An agent drafted an automation for you to review and import",
  },
];

export const InboxNotification = z.object({
  id: z.string(),
  kind: NotificationKind,
  taskId: z.string().nullable(),
  /** The headline, e.g. "Checks failing on #12". */
  title: z.string(),
  /** The task (`#81 Title`) and any detail. */
  body: z.string(),
  createdAt: z.string(),
  /** Null while unread. */
  readAt: z.string().nullable(),
});
export type InboxNotification = z.infer<typeof InboxNotification>;

/** `GET /api/notifications`: newest first, and how many are unread across all of them. */
export const NotificationList = z.object({ items: z.array(InboxNotification), unread: z.number().int().min(0) });
export type NotificationList = z.infer<typeof NotificationList>;

/** What a producer hands to `notify()`. */
export interface NotifyInput {
  kind: NotificationKind;
  taskId?: string | null;
  title: string;
  body: string;
  /** Changes exactly when the state does; a second notify with the same key is dropped. */
  dedupeKey: string;
}

/** A switch per kind, and whether quiet hours (Autopilot's window) keep popups quiet. */
export const NotificationSettings = z.object({
  kinds: z.record(NotificationKind, z.boolean()),
  /** During quiet hours a notification goes to the inbox only: no OS popup. */
  muteInQuietHours: z.boolean(),
});
export type NotificationSettings = z.infer<typeof NotificationSettings>;

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  kinds: Object.fromEntries(NotificationKind.options.map((kind) => [kind, true])) as Record<NotificationKind, boolean>,
  muteInQuietHours: true,
};

export const UpdateNotificationSettingsInput = z.object({
  kinds: z.partialRecord(NotificationKind, z.boolean()).optional(),
  muteInQuietHours: z.boolean().optional(),
});
export type UpdateNotificationSettingsInput = z.infer<typeof UpdateNotificationSettingsInput>;

/** Largest number the taskbar badge shows; more reads "9+". */
export const BADGE_MAX = 9;

/** The text on a count badge ("3", "9+"), or null at zero. */
export function badgeText(count: number): string | null {
  if (count <= 0) return null;
  return count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);
}
