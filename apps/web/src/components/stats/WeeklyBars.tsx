import type { StatsBucket } from "@repo/contracts";
import {
  CHART,
  ChartFrame,
  ChartTable,
  ChartTooltip,
  Legend,
  PLOT_HEIGHT,
  PLOT_WIDTH,
  XAxis,
  YAxis,
  useChartCursor,
  useBucketTitle,
  yFor,
  type ChartSeries,
} from "./chartParts";
import { niceScale } from "./stats.logic";

/** A bar from the baseline up with its top corners rounded and the baseline end square. */
function barPath(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.min(radius, width / 2, height);
  return `M${x},${y + height} V${y + r} Q${x},${y} ${x + r},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${y + height} Z`;
}

const MAX_BAR_WIDTH = 28;

/**
 * Bars, one slot per bucket (a week, or a day). `grouped` puts a series' bars side by side; `stacked` piles them in series order.
 * Hover uses a slot-wide hit area, so a tiny bar is as easy to point at as a tall one.
 */
export function WeeklyBars({
  buckets,
  series,
  mode = "grouped",
  integer = false,
  format,
  label,
}: {
  buckets: ReadonlyArray<StatsBucket>;
  series: ReadonlyArray<ChartSeries>;
  mode?: "grouped" | "stacked";
  /** Values are counts, so the axis only ticks on whole numbers. */
  integer?: boolean;
  format: (value: number | null) => string;
  /** What the chart shows, for assistive tech: "Tasks created and completed per week". */
  label: string;
}) {
  const cursor = useChartCursor(buckets.length);
  const bucketTitle = useBucketTitle();
  const n = buckets.length;
  const totals = buckets.map((_, i) =>
    mode === "stacked"
      ? series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0)
      : Math.max(0, ...series.map((s) => s.values[i] ?? 0)),
  );
  const { max, ticks } = niceScale(Math.max(0, ...totals), 4, integer);
  const slot = n > 0 ? PLOT_WIDTH / n : PLOT_WIDTH;
  const groupWidth = Math.min(slot * 0.72, MAX_BAR_WIDTH * (mode === "grouped" ? series.length : 1));
  const centers = buckets.map((_, i) => CHART.left + slot * i + slot / 2);
  const barWidth = mode === "grouped" ? (groupWidth - (series.length - 1) * 2) / series.length : groupWidth;
  const active = cursor.active !== null ? buckets[cursor.active] : undefined;

  return (
    <ChartFrame
      label={label}
      legend={<Legend series={series} />}
      cursor={cursor}
      tooltip={
        cursor.active !== null && active ? (
          <ChartTooltip
            x={centers[cursor.active]!}
            title={bucketTitle(active, cursor.active, n)}
            rows={series.map((s) => ({
              key: s.key,
              label: s.label,
              color: s.color,
              value: format(s.values[cursor.active!] ?? 0),
            }))}
          />
        ) : null
      }
      table={<ChartTable caption={label} buckets={buckets} series={series} format={format} />}
    >
      <YAxis ticks={ticks} max={max} format={(v) => format(v)} />
      {cursor.active !== null ? (
        <rect
          x={CHART.left + slot * cursor.active}
          y={CHART.top}
          width={slot}
          height={PLOT_HEIGHT}
          fill="var(--color-accent)"
          opacity={0.5}
          rx={4}
        />
      ) : null}
      {buckets.map((bucket, i) => {
        const left = centers[i]! - groupWidth / 2;
        let stackTop = 0;
        const bars = series.map((s, k) => {
          const value = s.values[i] ?? 0;
          if (value <= 0) return null;
          const height = Math.max((value / max) * PLOT_HEIGHT, 1);
          if (mode === "grouped") {
            const x = left + k * (barWidth + 2);
            return <path key={s.key} d={barPath(x, yFor(value, max), barWidth, height, 4)} fill={s.color} />;
          }
          // Stacked: each segment sits on the one below; a surface-coloured stroke leaves the gap between fills.
          const y = yFor(stackTop + value, max);
          stackTop += value;
          const isTop = series.slice(k + 1).every((later) => (later.values[i] ?? 0) <= 0);
          return (
            <path
              key={s.key}
              d={
                isTop ? barPath(left, y, barWidth, height, 4) : `M${left},${y} h${barWidth} v${height} h${-barWidth} Z`
              }
              fill={s.color}
              stroke="var(--color-card)"
              strokeWidth={1}
            />
          );
        });
        return (
          <g key={bucket.start}>
            {bars}
            <rect
              x={CHART.left + slot * i}
              y={CHART.top}
              width={slot}
              height={PLOT_HEIGHT}
              fill="transparent"
              onPointerEnter={() => cursor.setActive(i)}
              onPointerMove={() => cursor.setActive(i)}
            />
          </g>
        );
      })}
      <XAxis buckets={buckets} centers={centers} />
    </ChartFrame>
  );
}
