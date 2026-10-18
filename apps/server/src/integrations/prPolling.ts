import type { TaskLink } from "@repo/contracts";

/**
 * How often each PR is read, by how much it is likely to change. A PR waiting on checks, or one someone just touched or
 * is looking at, changes within seconds; an idle open PR changes when a person acts; a finished one almost never.
 */
const HOT_INTERVAL_MS = 20_000;
export const WARM_INTERVAL_MS = 2 * 60_000;
export const COLD_INTERVAL_MS = 30 * 60_000;
/** How often the poller looks for PRs that are due: the shortest interval. */
export const POLL_TICK_MS = HOT_INTERVAL_MS;

/** A PR linked or updated this recently is hot: checks start and reviews arrive in the first minutes. */
export const RECENT_MS = 10 * 60_000;
/** A task panel opening reads its PRs again when the last read is older than this. */
export const PANEL_REFRESH_AGE_MS = 15_000;
/** How long after the panel last asked a task counts as open. The panel asks again every `POLL_TICK_MS` while it is. */
export const PANEL_OPEN_TTL_MS = 2 * POLL_TICK_MS;
/** A tick fires a little before or after the interval since the last read, so a PR is due slightly early. */
const DUE_SLACK_MS = 2_000;

export type PrTier = "hot" | "warm" | "cold";

const INTERVALS: Record<PrTier, number> = {
  hot: HOT_INTERVAL_MS,
  warm: WARM_INTERVAL_MS,
  cold: COLD_INTERVAL_MS,
};

type PrLink = Extract<TaskLink, { kind: "pr" }>;

const within = (iso: string | null | undefined, now: number, windowMs: number): boolean => {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return !Number.isNaN(at) && now - at < windowMs;
};

/** The tier a PR link is read at: `viewed` is whether its task's panel is open. */
export function prTier(link: PrLink, now: number, viewed: boolean): PrTier {
  const snapshot = link.snapshot;
  if (!snapshot) return "hot";
  if (snapshot.state === "merged" || snapshot.state === "closed") return "cold";
  if (
    viewed ||
    snapshot.checks === "pending" ||
    // Optional checks still running: the row shows their count, so keep it current too.
    (snapshot.optionalChecks?.pending ?? 0) > 0 ||
    within(link.createdAt, now, RECENT_MS) ||
    within(snapshot.updatedAt, now, RECENT_MS)
  ) {
    return "hot";
  }
  return "warm";
}

/** Whether the link has gone unread for its tier's interval. A link never read is always due. */
export function prIsDue(link: PrLink, now: number, viewed: boolean): boolean {
  const syncedAt = link.syncedAt ? Date.parse(link.syncedAt) : Number.NaN;
  if (Number.isNaN(syncedAt)) return true;
  return now - syncedAt >= INTERVALS[prTier(link, now, viewed)] - DUE_SLACK_MS;
}

/** Whether the link's last read is older than `maxAgeMs`, or it has none. */
export const isOlderThan = (link: PrLink, now: number, maxAgeMs: number): boolean =>
  !within(link.syncedAt, now, maxAgeMs);
