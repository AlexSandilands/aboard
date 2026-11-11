import {
  automationTitleOf,
  totalTokens,
  type TaskDetail,
  type TaskLink,
  type TaskUsageRow,
  type TokenUsage,
} from "@repo/contracts";
import { ChevronRightIcon, ExternalLinkIcon, SquareTerminalIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { HarnessIcon, T3Icon } from "~/components/sessions/SessionParts";
import { SERIES_COLORS } from "~/components/stats/chartParts";
import { useSessionActions } from "~/components/sessions/useSessionActions";
import { t3LinkTargets } from "~/lib/t3Links";
import { cn } from "~/lib/utils";
import { useAutopilotOverview, useBoard, useSettings } from "~/state/queries";
import { linkProps, T3_UNDETECTED } from "./LinksSection";
import { PANEL_ICON_CLASS, PanelControl, PanelSplitGroup, PanelSplitSeparator } from "./PanelControl";
import { TaskSection } from "./TaskSection";
import {
  formatTokens,
  percents,
  rowCost,
  rowModel,
  rowName,
  rowSource,
  tokenMix,
  usageSummary,
  usageTotalDetail,
  formatCost,
} from "./usage.logic";

// One colour per kind of token, the stats page's series colours, so the bar reads in both themes.
const KIND_COLORS = [SERIES_COLORS.primary, SERIES_COLORS.success, SERIES_COLORS.muted, SERIES_COLORS.warning];

const COLUMNS = "grid grid-cols-[minmax(0,1fr)_minmax(0,6.5rem)_3.25rem_3.75rem] items-center gap-2";

/**
 * Tokens and API-equivalent cost of the task's sessions, T3 threads and board runs (docs/features/token-usage.md):
 * the total, what kind of tokens they were, then a row per source that opens to its breakdown.
 */
export function UsageSection({ task }: { task: TaskDetail }) {
  const usage = task.usage;
  const catalogue = useAutopilotOverview().data?.automations ?? [];
  const automationTitle = (key: string) => automationTitleOf(catalogue, key);
  return (
    <TaskSection title="Usage" summary={usage ? <UsageSummaryText text={usageSummary(usage)} /> : null}>
      {!usage ? (
        <p className="px-2.5 py-1 text-xs text-muted-foreground">No tokens read yet</p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 px-2.5">
            <span className="text-lg font-semibold tabular-nums">
              {formatCost(usage.costUsd, usage.costSource) ?? "No price"}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">{usageTotalDetail(usage)}</span>
          </div>
          <TokenMix tokens={usage.tokens} />
          <div className="flex flex-col">
            <div className={cn(COLUMNS, "px-2.5 pb-1 text-2xs font-medium text-muted-foreground")} aria-hidden>
              <span>Source</span>
              <span>Model</span>
              <span className="text-end">Tokens</span>
              <span className="text-end">Cost</span>
            </div>
            {usage.rows.map((row) => (
              <UsageRow key={row.key} task={task} row={row} automationTitle={automationTitle} />
            ))}
          </div>
          <p className="px-2.5 text-2xs text-muted-foreground">
            ~ API-equivalent estimate at list prices (as of {usage.pricesAsOf}); a plan may cost less.
          </p>
        </div>
      )}
    </TaskSection>
  );
}

function UsageSummaryText({ text }: { text: string }) {
  return <span className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">{text}</span>;
}

function TokenMix({ tokens }: { tokens: TokenUsage }) {
  const mix = tokenMix(tokens);
  if (totalTokens(tokens) === 0) return null;
  const shown = percents(mix.map((m) => m.share));
  return (
    <div className="flex flex-col gap-1.5 px-2.5">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        {mix.map((m, i) => (
          <span key={m.key} style={{ width: `${m.share * 100}%`, background: KIND_COLORS[i] }} />
        ))}
      </div>
      <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-0.5 p-0 text-2xs text-muted-foreground">
        {mix.map((m, i) => (
          <li key={m.key} className="flex items-center gap-1.5 tabular-nums">
            <span aria-hidden className="size-1.5 rounded-full" style={{ background: KIND_COLORS[i] }} />
            {m.label} {shown[i]}%
          </li>
        ))}
      </ul>
    </div>
  );
}

function RowIcon({ row }: { row: TaskUsageRow }) {
  if (row.harness === "t3") return <T3Icon className={PANEL_ICON_CLASS} />;
  return <HarnessIcon harness={row.harness} className="size-4 shrink-0" />;
}

function UsageRow({
  task,
  row,
  automationTitle,
}: {
  task: TaskDetail;
  row: TaskUsageRow;
  automationTitle: (key: string) => string | null;
}) {
  const [open, setOpen] = useState(false);
  const link = row.linkId ? task.links.find((l) => l.id === row.linkId) : undefined;
  const name = rowName(row, automationTitle);
  const tokens = totalTokens(row.tokens);
  return (
    <div className="flex flex-col">
      <PanelSplitGroup>
        <PanelControl
          part={link ? "primary" : "row"}
          className="h-auto py-1.5"
          aria-expanded={open}
          title={`${open ? "Hide" : "Show"} the token breakdown of ${name}`}
          onClick={() => setOpen(!open)}
        >
          <span className={cn(COLUMNS, "w-full")}>
            <span className="flex min-w-0 items-center gap-2">
              <ChevronRightIcon
                aria-hidden
                className={cn("size-3 shrink-0 text-muted-foreground/70 transition-transform", open && "rotate-90")}
              />
              <RowIcon row={row} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{name}</span>
                <span className="flex min-w-0 flex-wrap items-center gap-1 text-xs font-normal text-muted-foreground">
                  <span className="truncate">{rowSource(row)}</span>
                  {row.sharedWith.length > 0 ? (
                    <Chip tone="info">shared with {row.sharedWith.map((n) => `#${n}`).join(", ")}</Chip>
                  ) : null}
                  {row.costSource === "reported" ? <Chip tone="success">reported</Chip> : null}
                </span>
              </span>
            </span>
            <span className="truncate text-xs font-normal text-muted-foreground" title={rowModel(row)}>
              {row.untracked ? "not tracked" : rowModel(row)}
            </span>
            <span className="text-end text-xs font-normal tabular-nums">
              {row.untracked ? "—" : formatTokens(tokens)}
              {row.tokens.requests ? (
                <span className="block text-muted-foreground">{row.tokens.requests} req</span>
              ) : null}
            </span>
            <span
              className={cn(
                "text-end text-xs tabular-nums",
                row.costUsd === null ? "font-normal text-muted-foreground" : "font-medium",
              )}
            >
              {rowCost(row)}
            </span>
          </span>
        </PanelControl>
        {link ? (
          <>
            <PanelSplitSeparator />
            <OpenSource task={task} link={link} />
          </>
        ) : null}
      </PanelSplitGroup>
      {open ? <Breakdown row={row} /> : null}
    </div>
  );
}

function Chip({ tone, children }: { tone: "info" | "success"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "rounded-full px-1.5 text-2xs font-medium whitespace-nowrap",
        tone === "info" && "bg-info/8 text-info-foreground dark:bg-info/16",
        tone === "success" && "bg-success/8 text-success-foreground dark:bg-success/16",
      )}
    >
      {children}
    </span>
  );
}

/** Opens the row's session in a terminal, or its thread in T3 Code: the same actions as in Sessions. */
function OpenSource({ task, link }: { task: TaskDetail; link: TaskLink }) {
  const { open, pending } = useSessionActions(task.id);
  const settings = useSettings().data;
  const t3 = useBoard().data?.integrations.t3 ?? T3_UNDETECTED;
  if (link.kind === "t3_thread") {
    const target = t3LinkTargets(link.ref, t3, settings).primary;
    return (
      <PanelControl
        part="secondary"
        aria-label={target.label}
        title={target.label}
        render={<a {...linkProps(target.href)} />}
      >
        <ExternalLinkIcon className={PANEL_ICON_CLASS} />
      </PanelControl>
    );
  }
  if (link.kind !== "agent_session") return null;
  return (
    <PanelControl
      part="secondary"
      aria-label="Open the session in a terminal"
      title="Open the session in a terminal"
      disabled={pending}
      onClick={() => open(link)}
    >
      <SquareTerminalIcon className={PANEL_ICON_CLASS} />
    </PanelControl>
  );
}

function Breakdown({ row }: { row: TaskUsageRow }) {
  const kinds = (t: TaskUsageRow["tokens"]) =>
    [
      ["input", t.input],
      ["output", t.output],
      ["cache read", t.cacheRead],
      ["cache write 5m", t.cacheWrite5m],
      ["cache write 1h", t.cacheWrite1h],
    ].filter(([, n]) => (n as number) > 0) as Array<[string, number]>;
  return (
    <ul className="m-0 mb-1 ms-9 list-none space-y-1 p-0 text-xs text-muted-foreground tabular-nums">
      {row.models.map((m) => (
        <li key={m.model ?? ""}>
          <span className="font-medium text-foreground/80">{m.model ?? "Unknown model"}</span>
          {" · "}
          {kinds(m.tokens)
            .map(([label, n]) => `${label} ${formatTokens(n)}`)
            .join(" · ")}
          {" · "}
          {m.costUsd === null ? "no price" : `~$${m.costUsd.toFixed(2)}`}
        </li>
      ))}
      {row.lastDay ? <li>Last used {row.lastDay}</li> : null}
    </ul>
  );
}
