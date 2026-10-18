import { z } from "zod";

// Weekly trends over the board's history (docs/features/stats.md).

/** The periods the stats view offers, in weeks. */
export const STATS_PERIODS = [4, 12, 52] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];

/** `GET /api/stats` query: the period in weeks and, optionally, one project. */
export const StatsQuery = z.object({
  weeks: z.coerce
    .number()
    .int()
    .refine((n): n is StatsPeriod => (STATS_PERIODS as readonly number[]).includes(n), {
      message: `weeks must be one of ${STATS_PERIODS.join(", ")}`,
    })
    .default(12),
  projectId: z.string().min(1).optional(),
});
export type StatsQuery = z.infer<typeof StatsQuery>;

/** How a series' values read: a count of things, a duration in milliseconds, dollars, or an average of counts. */
export const StatsUnit = z.enum(["count", "ms", "usd", "ratio"]);
export type StatsUnit = z.infer<typeof StatsUnit>;

/** One calendar week, Monday 00:00 to the next Monday 00:00 in the server's local time, as instants. */
export const StatsBucket = z.object({
  start: z.string(),
  end: z.string(),
});
export type StatsBucket = z.infer<typeof StatsBucket>;

export const StatsSeries = z.object({
  unit: StatsUnit,
  /**
   * One value per bucket, oldest first. Counts and costs are 0 in a quiet week; durations and ratios are null when
   * nothing in the week had one.
   */
  values: z.array(z.number().nullable()),
  /** Over the whole period: the sum for counts and costs, the median for durations, the mean for ratios. */
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

/** A count split by a category over the whole period (not per week), largest first. */
export const StatsBreakdown = z.object({
  unit: StatsUnit,
  items: z.array(StatsBreakdownItem),
});
export type StatsBreakdown = z.infer<typeof StatsBreakdown>;

/**
 * Weekly stats. `series` is a map by name, so a new metric is a new key and never a change to the shape. Names are
 * stable ids (`tasks_completed`, `autopilot.runs.<automation>.<status>`); labels are the client's to write. Fixed
 * series are always present; per-automation ones only when the automation ran in the two periods. `breakdowns` is
 * the same idea for splits of the period by category (`completed_by_label`), also keyed by stable name.
 */
export const StatsResponse = z.object({
  weeks: z.number().int(),
  /** The period as instants: the first bucket's start to the last bucket's end. */
  from: z.string(),
  to: z.string(),
  /** Where the previous period begins; it ends at `from`. */
  previousFrom: z.string(),
  /** Null for the whole board. */
  project: z.object({ id: z.string(), title: z.string() }).nullable(),
  buckets: z.array(StatsBucket),
  series: z.record(z.string(), StatsSeries),
  breakdowns: z.record(z.string(), StatsBreakdown),
  /** Things a reader should know about the numbers, e.g. a project whose git history couldn't be read. */
  notes: z.array(z.string()),
});
export type StatsResponse = z.infer<typeof StatsResponse>;
