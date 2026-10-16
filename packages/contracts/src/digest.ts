import { z } from "zod";
import { latestDue, localStamp } from "./recurring.ts";

// Digest of what changed: an Autopilot automation that writes a board-wide summary of the period since the last one
// (docs/features/autopilot.md#digest-of-what-changed).

/** The automation's key. Stored in settings and runs, so never renamed. */
export const AUTOPILOT_DIGEST = "digest";

/** Plain is built by the board; summarised is plain handed to an agent to write up. */
export const DigestMode = z.enum(["plain", "summarised"]);
export type DigestMode = z.infer<typeof DigestMode>;

/** Made on the schedule, or by the user (the header button or the command palette). */
export const DigestTrigger = z.enum(["schedule", "manual"]);
export type DigestTrigger = z.infer<typeof DigestTrigger>;

/** How many digests are kept; older ones are dropped when a new one is made. */
export const DIGEST_KEEP = 30;

/** The first digest covers this long. */
export const DIGEST_FIRST_PERIOD_MS = 24 * 60 * 60 * 1000;

export const Digest = z.object({
  id: z.string(),
  createdAt: z.string(),
  /** The period it covers, as instants. */
  from: z.string(),
  to: z.string(),
  /** What the body is, which is plain when a summary was asked for and failed. */
  mode: DigestMode,
  trigger: DigestTrigger,
  /** Markdown; task numbers are written `#42` so the UI can link them. */
  bodyMd: z.string(),
  costUsd: z.number().nullable(),
  /** Why a summarised digest came out plain. */
  note: z.string().nullable(),
  /** Null until the user opened it. */
  readAt: z.string().nullable(),
});
export type Digest = z.infer<typeof Digest>;

/** `GET /api/digests`: newest first, and how many are unread. */
export const DigestList = z.object({ items: z.array(Digest), unread: z.number().int().min(0) });
export type DigestList = z.infer<typeof DigestList>;

/**
 * The latest scheduled slot at or before `now` that is after `since` (an instant), or null. `since` is the later of
 * the newest digest's creation (any trigger: one made by hand after a slot counts as that slot's) and the last change
 * to the automation's settings, so switching it on, or moving its time, doesn't make a digest for a slot that
 * passed before. Only the latest slot: a board that was off for three days makes one digest, covering them all.
 */
export function dueDigestSlot(
  schedule: { time: string; weekdaysOnly: boolean },
  now: Date,
  since: string,
): Date | null {
  const days = schedule.weekdaysOnly ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6];
  return latestDue({ kind: "weekly", days, time: schedule.time }, now, localStamp(new Date(since)));
}
