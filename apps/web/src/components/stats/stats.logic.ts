import { STATS_PERIODS, type StatsBucket, type StatsPeriod, type StatsResponse, type StatsUnit } from "@repo/contracts";

/** The period shown when `?weeks=` is missing or isn't one the API takes. */
export const DEFAULT_STATS_PERIOD: StatsPeriod = 12;

/** `?weeks=` as a period, or the default for anything else. */
export function parseStatsPeriod(value: unknown): StatsPeriod {
  const n = Number(value);
  return STATS_PERIODS.find((period) => period === n) ?? DEFAULT_STATS_PERIOD;
}

/**
 * Round tick values from 0 up to a "nice" ceiling at or above `max`, about `count` of them. A flat zero series still
 * gets a scale so its chart has an axis.
 */
export function niceScale(max: number, count = 4): { max: number; ticks: number[] } {
  if (!Number.isFinite(max) || max <= 0) return { max: 1, ticks: [0, 1] };
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const step = (residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10) * magnitude;
  const top = Number((Math.ceil(max / step - 1e-9) * step).toPrecision(12));
  const ticks: number[] = [];
  // Counting steps rather than adding to a float keeps 0.1 + 0.2 style drift out of the labels.
  for (let i = 0; i * step <= top + step / 1e6; i++) ticks.push(Number((i * step).toPrecision(12)));
  return { max: top, ticks };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const DURATION_STEPS = [1, 5, 10, 15, 30, 60, 120, 240, 360, 720, 1440, 2880, 10080, 20160, 43200].map(
  (m) => m * 60_000,
);

/** Like `niceScale`, but with ticks on durations people count in (30m, 2h, 1d, 1w) rather than round milliseconds. */
export function niceDurationScale(max: number, count = 4): { max: number; ticks: number[] } {
  if (!Number.isFinite(max) || max <= 0) return { max: 60_000, ticks: [0, 60_000] };
  const step = DURATION_STEPS.find((candidate) => Math.ceil(max / candidate) <= count);
  if (step === undefined) {
    // Longer than the table: round multiples of the largest step.
    const largest = DURATION_STEPS.at(-1)!;
    const scale = niceScale(max / largest, count);
    return { max: scale.max * largest, ticks: scale.ticks.map((t) => t * largest) };
  }
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= top; t += step) ticks.push(t);
  return { max: top, ticks };
}

/** A duration as its two leading units: "2d 4h", "3h 20m", "45m", "30s". */
export function formatDuration(ms: number): string {
  if (ms < MINUTE) return `${Math.round(ms / 1000)}s`;
  // Whole minutes first, so 59.6 minutes becomes "1h" and not "60m" or "1h 60m".
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) {
    const m = minutes % 60;
    return m === 0 ? `${minutes / 60}h` : `${Math.floor(minutes / 60)}h ${m}m`;
  }
  const totalHours = Math.round(ms / HOUR);
  const h = totalHours % 24;
  return h === 0 ? `${totalHours / 24}d` : `${Math.floor(totalHours / 24)}d ${h}h`;
}

/** A series value as the page writes it. `null` (nothing in the week) reads as a dash. */
export function formatStatsValue(value: number | null, unit: StatsUnit): string {
  if (value === null) return "–";
  switch (unit) {
    case "ms":
      return formatDuration(value);
    case "usd":
      return value < 10 ? `$${value.toFixed(2)}` : `$${Math.round(value).toLocaleString("en-US")}`;
    case "ratio":
      return value.toFixed(value < 10 ? 1 : 0);
    case "count":
      return Math.round(value).toLocaleString("en-US");
  }
}

export type StatsChange = {
  /** "+12%", "−8%", "no change", or "new" when there was nothing before. */
  label: string;
  direction: "up" | "down" | "flat";
};

/** How `total` compares with `previousTotal`: a percentage, or null when either side has no value to compare. */
export function changeVsPrevious(total: number | null, previousTotal: number | null): StatsChange | null {
  if (total === null || previousTotal === null) return null;
  if (previousTotal === 0)
    return total === 0 ? { label: "no change", direction: "flat" } : { label: "new", direction: "up" };
  const percent = Math.round(((total - previousTotal) / Math.abs(previousTotal)) * 100);
  if (percent === 0) return { label: "no change", direction: "flat" };
  return {
    label: `${percent > 0 ? "+" : "−"}${Math.abs(percent)}%`,
    direction: percent > 0 ? "up" : "down",
  };
}

const SHORT_DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

/** A week's start as "Oct 6", the bucket's label on an axis and in a tooltip. */
export function bucketLabel(bucket: StatsBucket): string {
  return SHORT_DATE.format(new Date(bucket.start));
}

/** The indices of the buckets that get an axis label: spread out so 52 weeks don't collide, always the last. */
export function axisLabelIndices(length: number, maxLabels = 6): number[] {
  if (length <= 0) return [];
  const stride = Math.ceil(length / maxLabels);
  const indices: number[] = [];
  // Counted back from the last bucket, so the current week is always labelled.
  for (let i = length - 1; i >= 0; i -= stride) indices.unshift(i);
  return indices;
}

/** A series' weekly values with nulls as zero, for bars. */
export function valuesOrZero(values: ReadonlyArray<number | null>): number[] {
  return values.map((v) => v ?? 0);
}

export type AutomationRuns = {
  automation: string;
  /** Finished runs by final status. */
  byStatus: Record<string, number>;
  total: number;
};

const RUNS_PREFIX = "autopilot.runs.";

/** Runs per automation over the period, from the `autopilot.runs.<automation>.<status>` series, busiest first. */
export function runsByAutomation(series: StatsResponse["series"]): AutomationRuns[] {
  const rows = new Map<string, AutomationRuns>();
  for (const [name, s] of Object.entries(series)) {
    if (!name.startsWith(RUNS_PREFIX)) continue;
    const rest = name.slice(RUNS_PREFIX.length);
    const dot = rest.lastIndexOf(".");
    if (dot <= 0) continue;
    const automation = rest.slice(0, dot);
    const status = rest.slice(dot + 1);
    const count = s.total ?? 0;
    const row = rows.get(automation) ?? { automation, byStatus: {}, total: 0 };
    row.byStatus[status] = (row.byStatus[status] ?? 0) + count;
    row.total += count;
    rows.set(automation, row);
  }
  return [...rows.values()]
    .filter((row) => row.total > 0)
    .sort((a, b) => b.total - a.total || a.automation.localeCompare(b.automation));
}

/** Weekly run counts for one status across every automation, from the same series. */
export function runsByStatusWeekly(series: StatsResponse["series"], status: string, weeks: number): number[] {
  const out = Array.from({ length: weeks }, () => 0);
  for (const [name, s] of Object.entries(series)) {
    if (!name.startsWith(RUNS_PREFIX) || !name.endsWith(`.${status}`)) continue;
    s.values.forEach((v, i) => {
      if (i < weeks) out[i] = (out[i] ?? 0) + (v ?? 0);
    });
  }
  return out;
}

/** Whether every series the page charts is quiet: nothing created, finished, merged, run or started in the period. */
export function isQuiet(series: StatsResponse["series"]): boolean {
  return Object.values(series).every((s) => (s.total ?? 0) === 0 && (s.previousTotal ?? 0) === 0);
}
