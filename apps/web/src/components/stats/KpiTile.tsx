import { ArrowDownRightIcon, ArrowUpRightIcon, MinusIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import type { StatsChange } from "./stats.logic";

/**
 * A headline number with how it moved against the previous period. `better` says which direction is an improvement
 * ("up" for tasks finished, "down" for cycle time); without it the change is shown neutrally, since more or fewer
 * isn't good or bad by itself (PRs merged, runs).
 */
export function KpiTile({
  label,
  value,
  change,
  better,
  previousLabel,
}: {
  label: string;
  value: string;
  change: StatsChange | null;
  better?: "up" | "down";
  /** What the change is against: "previous 12 weeks". */
  previousLabel: string;
}) {
  const verdict =
    change && better && change.direction !== "flat" ? (change.direction === better ? "good" : "bad") : "neutral";
  const Icon =
    change?.direction === "up" ? ArrowUpRightIcon : change?.direction === "down" ? ArrowDownRightIcon : MinusIcon;
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div
        className={cn(
          "mt-1 flex items-center gap-1 text-xs",
          verdict === "good" && "text-success-foreground",
          verdict === "bad" && "text-error-foreground",
          verdict === "neutral" && "text-muted-foreground",
        )}
      >
        {change ? (
          <>
            <Icon aria-hidden className="size-3.5" />
            <span className="font-medium tabular-nums">{change.label}</span>
            <span className="text-muted-foreground">vs {previousLabel}</span>
          </>
        ) : (
          <span className="text-muted-foreground">Nothing to compare yet</span>
        )}
      </div>
    </div>
  );
}
