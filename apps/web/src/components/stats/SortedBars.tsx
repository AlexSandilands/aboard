import type { BreakdownRow } from "./stats.logic";

/**
 * Horizontal bars for one period's breakdown, largest first, each with its value and what the previous period had.
 * The rows are the chart: values are written out, so there is nothing to hover and a list is all a screen reader needs.
 */
export function SortedBars({
  rows,
  color,
  label,
  previousLabel,
}: {
  rows: ReadonlyArray<BreakdownRow>;
  /** A theme token from `SERIES_COLORS`. */
  color: string;
  /** What the chart shows, for assistive tech: "Finished tasks by label". */
  label: string;
  /** What the "was" figure is against: "previous 12 weeks". */
  previousLabel: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul aria-label={label} className="m-0 list-none space-y-1.5 p-0">
      {rows.map((row) => (
        <li key={row.key} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-3 text-xs">
          <span className="truncate" title={row.label}>
            {row.label}
          </span>
          <span aria-hidden className="block h-3 rounded-sm bg-muted/40">
            <span
              className="block h-full rounded-sm"
              // Never thinner than a sliver, so a count of 1 beside 200 still shows.
              style={{ width: `${Math.max((row.value / max) * 100, 1.5)}%`, background: color }}
            />
          </span>
          <span className="flex items-baseline gap-1.5 tabular-nums">
            <span className="font-medium">{row.value}</span>
            <span className="text-muted-foreground">
              <span className="sr-only">
                , {row.previous} in the {previousLabel}
              </span>
              <span aria-hidden>was {row.previous}</span>
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
