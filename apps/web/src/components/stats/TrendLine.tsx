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
  weekTitle,
  yFor,
  type ChartSeries,
} from "./chartParts";
import { niceDurationScale, niceScale } from "./stats.logic";

/** The path of one series: a line per run of weeks that have a value, so a quiet week is a gap and not a drop to zero. */
function linePath(values: ReadonlyArray<number | null>, xs: ReadonlyArray<number>, max: number): string {
  let d = "";
  let drawing = false;
  values.forEach((value, i) => {
    if (value === null) {
      drawing = false;
      return;
    }
    d += `${drawing ? "L" : "M"}${xs[i]!.toFixed(1)},${yFor(value, max).toFixed(1)} `;
    drawing = true;
  });
  return d.trim();
}

const DOT = 3.5;

/** Weekly values as a line. Weeks with no value (`null`) break the line. */
export function TrendLine({
  buckets,
  series,
  format,
  label,
  durations = false,
}: {
  buckets: ReadonlyArray<StatsBucket>;
  series: ReadonlyArray<ChartSeries>;
  format: (value: number | null) => string;
  label: string;
  /** Values are milliseconds, so the axis ticks fall on minutes, hours and days. */
  durations?: boolean;
}) {
  const cursor = useChartCursor(buckets.length);
  const n = buckets.length;
  const highest = Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0)));
  const { max, ticks } = durations ? niceDurationScale(highest) : niceScale(highest);
  const step = n > 0 ? PLOT_WIDTH / n : PLOT_WIDTH;
  const xs = buckets.map((_, i) => CHART.left + step * i + step / 2);
  // A year of weeks would be a bead string; dots then only mark weeks that stand alone (no neighbour to join) and the hovered one.
  const dotsAlways = n <= 13;
  const active = cursor.active !== null ? buckets[cursor.active] : undefined;

  return (
    <ChartFrame
      label={label}
      legend={<Legend series={series} />}
      cursor={cursor}
      tooltip={
        cursor.active !== null && active ? (
          <ChartTooltip
            x={xs[cursor.active]!}
            title={weekTitle(active, cursor.active, n)}
            rows={series.map((s) => ({
              key: s.key,
              label: s.label,
              color: s.color,
              value: format(s.values[cursor.active!] ?? null),
            }))}
          />
        ) : null
      }
      table={<ChartTable caption={label} buckets={buckets} series={series} format={format} />}
    >
      <YAxis ticks={ticks} max={max} format={(v) => format(v)} />
      {cursor.active !== null ? (
        <line
          x1={xs[cursor.active]}
          x2={xs[cursor.active]}
          y1={CHART.top}
          y2={CHART.top + PLOT_HEIGHT}
          stroke="var(--color-border)"
        />
      ) : null}
      {series.map((s) => (
        <g key={s.key}>
          <path
            d={linePath(s.values, xs, max)}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {s.values.map((value, i) => {
            if (value === null) return null;
            const alone = s.values[i - 1] == null && s.values[i + 1] == null;
            const hovered = cursor.active === i;
            if (!dotsAlways && !alone && !hovered) return null;
            return (
              <circle
                key={buckets[i]!.start}
                cx={xs[i]}
                cy={yFor(value, max)}
                r={hovered ? DOT + 1.5 : DOT}
                fill={s.color}
                // A surface ring keeps dots legible where lines cross.
                stroke="var(--color-card)"
                strokeWidth={2}
              />
            );
          })}
        </g>
      ))}
      {buckets.map((bucket, i) => (
        <rect
          key={bucket.start}
          x={CHART.left + step * i}
          y={CHART.top}
          width={step}
          height={PLOT_HEIGHT}
          fill="transparent"
          onPointerEnter={() => cursor.setActive(i)}
          onPointerMove={() => cursor.setActive(i)}
        />
      ))}
      <XAxis buckets={buckets} centers={xs} />
    </ChartFrame>
  );
}
