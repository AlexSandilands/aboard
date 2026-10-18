import type { StatsBucket, StatsBucketKind } from "@repo/contracts";
import { createContext, useCallback, useContext, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { axisLabelIndices, bucketLabel, bucketTitle } from "./stats.logic";

/** What the charts' buckets are, set once by the page: it words the axes, tooltips and screen reader text. */
export const BucketKindContext = createContext<StatsBucketKind>("week");

const useBucketKind = (): StatsBucketKind => useContext(BucketKindContext);

/** The drawing box every chart shares: wide, so the SVG scales down with its container and keeps its proportions. */
export const CHART = {
  width: 640,
  height: 170,
  left: 40,
  right: 8,
  top: 10,
  bottom: 20,
} as const;
export const PLOT_WIDTH = CHART.width - CHART.left - CHART.right;
export const PLOT_HEIGHT = CHART.height - CHART.top - CHART.bottom;

/**
 * Theme tokens a series can wear, so a chart reads in light, dark and custom themes. Identity never rides on colour
 * alone: legends and tooltips name each series.
 */
export const SERIES_COLORS = {
  primary: "var(--color-primary)",
  muted: "color-mix(in srgb, var(--color-muted-foreground) 55%, transparent)",
  success: "var(--color-success)",
  info: "var(--color-info)",
  warning: "var(--color-warning)",
  error: "var(--color-error)",
} as const;

export type ChartSeries = {
  key: string;
  label: string;
  color: string;
  values: ReadonlyArray<number | null>;
};

/** Y position for a value on a 0..max scale. */
export function yFor(value: number, max: number): number {
  return CHART.top + PLOT_HEIGHT - (value / max) * PLOT_HEIGHT;
}

/** The bucket under the pointer or keyboard cursor, and the handlers that move it. */
export function useChartCursor(count: number) {
  const [active, setActive] = useState<number | null>(null);
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActive(null);
        return;
      }
      if (count === 0) return;
      const last = count - 1;
      let next: number | null = null;
      if (event.key === "ArrowLeft") next = active === null ? last : Math.max(0, active - 1);
      else if (event.key === "ArrowRight") next = active === null ? 0 : Math.min(last, active + 1);
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = last;
      if (next === null) return;
      event.preventDefault();
      setActive(next);
    },
    [active, count],
  );
  const clear = useCallback(() => setActive(null), []);
  return { active, setActive, onKeyDown, clear };
}

/** Horizontal gridlines with their value labels. */
export function YAxis({ ticks, max, format }: { ticks: number[]; max: number; format: (value: number) => string }) {
  return (
    <g aria-hidden>
      {ticks.map((tick) => {
        const y = yFor(tick, max);
        return (
          <g key={tick}>
            <line
              x1={CHART.left}
              x2={CHART.width - CHART.right}
              y1={y}
              y2={y}
              stroke="var(--color-border)"
              strokeOpacity={tick === 0 ? 1 : 0.6}
              strokeDasharray={tick === 0 ? undefined : "2 3"}
            />
            <text
              x={CHART.left - 6}
              y={y}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {format(tick)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/** Bucket-start labels along the bottom, thinned so a year of weeks stays readable. `centers` is each bucket's x. */
export function XAxis({ buckets, centers }: { buckets: ReadonlyArray<StatsBucket>; centers: ReadonlyArray<number> }) {
  const kind = useBucketKind();
  return (
    <g aria-hidden>
      {axisLabelIndices(buckets.length, kind === "day" ? 7 : 6).map((i) => (
        <text
          key={i}
          x={centers[i]}
          y={CHART.height - 5}
          textAnchor="middle"
          className="fill-muted-foreground text-[10px]"
        >
          {bucketLabel(buckets[i]!, kind)}
        </text>
      ))}
    </g>
  );
}

export function Legend({ series }: { series: ReadonlyArray<ChartSeries> }) {
  if (series.length < 2) return null;
  return (
    <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-[3px]" style={{ background: s.color }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * The hover card for one bucket, placed over the chart at `x` (in drawing units) and clamped so it never leaves the
 * chart. Not interactive, so it never steals the pointer from the marks under it.
 */
export function ChartTooltip({
  x,
  title,
  rows,
}: {
  x: number;
  title: string;
  rows: ReadonlyArray<{
    key: string;
    label: string;
    color: string;
    value: string;
  }>;
}) {
  const percent = Math.min(80, Math.max(20, (x / CHART.width) * 100));
  return (
    <div
      role="presentation"
      className="pointer-events-none absolute top-0 z-10 min-w-36 whitespace-nowrap -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-lg/10"
      style={{ left: `${percent}%` }}
    >
      <div className="mb-1 font-medium">{title}</div>
      {rows.map((row) => (
        <div key={row.key} className="flex items-center gap-2">
          <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: row.color }} />
          <span className="text-muted-foreground">{row.label}</span>
          <span className="ms-auto ps-3 font-medium tabular-nums">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

/** The tooltip's title for a bucket: "Week of Oct 6" or "Mon, Oct 13", marked as partial for the last one. */
export function useBucketTitle(): (bucket: StatsBucket, index: number, count: number) => string {
  const kind = useBucketKind();
  return (bucket, index, count) => bucketTitle(bucket, index, count, kind);
}

/** The chart's values as a table for screen readers, which can't read an SVG's marks. */
export function ChartTable({
  caption,
  buckets,
  series,
  format,
}: {
  caption: string;
  buckets: ReadonlyArray<StatsBucket>;
  series: ReadonlyArray<ChartSeries>;
  format: (value: number | null) => string;
}) {
  const kind = useBucketKind();
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{kind === "day" ? "Day" : "Week of"}</th>
          {series.map((s) => (
            <th key={s.key} scope="col">
              {s.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {buckets.map((bucket, i) => (
          <tr key={bucket.start}>
            <th scope="row">{bucketLabel(bucket, kind)}</th>
            {series.map((s) => (
              <td key={s.key}>{format(s.values[i] ?? null)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The frame shared by the charts: legend, the SVG in a focusable region the arrow keys move through, the tooltip
 * above it and the screen reader table. The caller draws the marks.
 */
export function ChartFrame({
  label,
  legend,
  cursor,
  tooltip,
  table,
  children,
  className,
}: {
  label: string;
  legend: ReactNode;
  cursor: { onKeyDown: (event: KeyboardEvent) => void; clear: () => void };
  tooltip: ReactNode;
  table: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const unit = useBucketKind() === "day" ? "days" : "weeks";
  return (
    <figure className={cn("m-0", className)}>
      {legend}
      <div className="relative">
        {tooltip}
        {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- arrow keys step through the buckets; the table is the screen reader view */}
        <svg
          viewBox={`0 0 ${CHART.width} ${CHART.height}`}
          role="group"
          aria-roledescription="chart"
          aria-label={`${label}. Use the arrow keys to move between ${unit}.`}
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the focusable chart is how keyboard users reach each bucket's values
          tabIndex={0}
          className="block h-auto w-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onKeyDown={cursor.onKeyDown}
          onBlur={cursor.clear}
          onPointerLeave={cursor.clear}
        >
          {children}
        </svg>
      </div>
      {table}
    </figure>
  );
}
