import { z } from "zod";
import { parseProjectScope } from "./savedViews.ts";

// Weekly trends over the board's history, or daily for a single week (docs/features/stats.md).

/** The periods the stats view offers, in weeks. One week is charted by day, the others by week. */
export const STATS_PERIODS = [1, 4, 12, 52] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];

/**
 * `GET /api/stats` query: the period in weeks and, optionally, some projects: `projectIds` is a comma list, and
 * `projectId` one project (the older form, kept as an alias). Parsed to the list of ids; empty is the whole board.
 */
export const StatsQuery = z
  .object({
    weeks: z.coerce
      .number()
      .int()
      .refine((n): n is StatsPeriod => (STATS_PERIODS as readonly number[]).includes(n), {
        message: `weeks must be one of ${STATS_PERIODS.join(", ")}`,
      })
      .default(12),
    projectId: z.string().min(1).optional(),
    projectIds: z.string().optional(),
  })
  .transform(({ weeks, projectId, projectIds }) => ({
    weeks,
    projectIds: parseProjectScope([projectIds, projectId].filter(Boolean).join(",")),
  }));
export type StatsQuery = z.infer<typeof StatsQuery>;

/** How a series' values read: a count of things, a duration in milliseconds, dollars, or an average of counts. */
export const StatsUnit = z.enum(["count", "ms", "usd", "ratio"]);
export type StatsUnit = z.infer<typeof StatsUnit>;

/**
 * One calendar week, Monday 00:00 to the next Monday 00:00 in the server's local time, as instants; or one day, midnight
 * to midnight, when the response's `bucket` is "day".
 */
export const StatsBucket = z.object({
  start: z.string(),
  end: z.string(),
});
export type StatsBucket = z.infer<typeof StatsBucket>;

/** What a bucket spans: a calendar week, or a day for the one-week period. */
export const StatsBucketKind = z.enum(["day", "week"]);
export type StatsBucketKind = z.infer<typeof StatsBucketKind>;

export const StatsSeries = z.object({
  unit: StatsUnit,
  /**
   * One value per bucket, oldest first. Counts and costs are 0 in a quiet bucket; durations and ratios are null when
   * nothing in the bucket had one.
   */
  values: z.array(z.number().nullable()),
  /**
   * Over the whole period: the sum for counts and costs, the median for durations, the mean for ratios. A series that
   * is a level rather than events (`open_tasks.<status>`) has where the period ended, and its previous where that did.
   */
  total: z.number().nullable(),
  /** The same for the period of equal length just before it, for comparison. */
  previousTotal: z.number().nullable(),
});
export type StatsSeries = z.infer<typeof StatsSeries>;

/** One row of a breakdown: how many fell under `key` in the period, and in the one before it. */
export const StatsBreakdownItem = z.object({
  /** Null for "none": a task without that label or tier. */
  key: z.string().nullable(),
  total: z.number(),
  previousTotal: z.number(),
});
export type StatsBreakdownItem = z.infer<typeof StatsBreakdownItem>;

/** A count split by a category over the whole period (not per bucket), largest first. */
export const StatsBreakdown = z.object({
  unit: StatsUnit,
  items: z.array(StatsBreakdownItem),
});
export type StatsBreakdown = z.infer<typeof StatsBreakdown>;

/**
 * Stats by week, or by day for a one-week period. `series` is a map by name, so a new metric is a new key and never a change to the shape. Names are
 * stable ids (`tasks_completed`, `autopilot.runs.<automation>.<status>`); labels are the client's to write. Fixed
 * series are always present; per-automation ones only when the automation ran in the two periods. `breakdowns` is
 * the same idea for splits of the period by category (`completed_by_label`), also keyed by stable name.
 */
export const StatsResponse = z.object({
  weeks: z.number().int(),
  /** What a bucket is: a calendar week, or a day when `weeks` is 1 (then 7 buckets, the last 7 days ending today). */
  bucket: StatsBucketKind,
  /** The period as instants: the first bucket's start to the last bucket's end. */
  from: z.string(),
  to: z.string(),
  /** Where the previous period begins; it ends at `from`. */
  previousFrom: z.string(),
  /** The projects the numbers cover, in the order asked for; empty for the whole board. */
  projects: z.array(z.object({ id: z.string(), title: z.string() })),
  buckets: z.array(StatsBucket),
  series: z.record(z.string(), StatsSeries),
  breakdowns: z.record(z.string(), StatsBreakdown),
  /** Things a reader should know about the numbers, e.g. a project whose git history couldn't be read. */
  notes: z.array(z.string()),
});
export type StatsResponse = z.infer<typeof StatsResponse>;
