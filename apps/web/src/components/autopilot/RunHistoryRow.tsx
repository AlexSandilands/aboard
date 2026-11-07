import { canRetryRun, fixAutomationPrompt, type AutopilotRun } from "@repo/contracts";
import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";
import { isWebUrl } from "~/components/task/links.logic";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { formatElapsedDurationLabel } from "~/lib/timestampFormat";
import { cn } from "~/lib/utils";
import { useRetryAutopilotRun } from "~/state/mutations";
import { copyFixPrompt } from "./askAgent";
import { formatCost, runStatusLabel, runStatusVariant, scheduledAnswerOf } from "./autopilot.logic";

/** Web URLs and T3 Code deep links; a runner's thread URL is shown as a link only if it is one of those. */
const isOpenable = (url: string) => isWebUrl(url) || url.startsWith("t3code://");

/**
 * One run in the history page: its status, automation, where it ran, when and what it said it did, with Retry when its
 * work can be tried again. Clicking it opens what else the run kept: the error and output, a scheduled agent's
 * handover, cost, model, the thread and the run id, with Ask an agent to fix on a failure. In select mode (Clean up…) a
 * checkbox selects it for deleting.
 */
export function RunHistoryRow({
  run,
  others,
  automation,
  projectTitle,
  taskNumber,
  open,
  onOpenChange,
  selecting,
  checked,
  disabled = false,
  onCheckedChange,
}: {
  run: AutopilotRun;
  /** The loaded runs around it, newest first, so Retry isn't offered on a run a later one superseded. */
  others: readonly AutopilotRun[];
  /** The automation's plain name. */
  automation: string;
  projectTitle: string | null;
  /** The run's task, when the board still has it. */
  taskNumber: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Clean up's select mode: a checkbox per run. */
  selecting: boolean;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const answer = scheduledAnswerOf(run);
  const at = run.finishedAt ?? run.startedAt ?? run.createdAt;
  const cost = formatCost(run.costUsd);
  const summary = answer?.summary || run.summary;
  // A deferred run's work comes round again by itself, on the new head: retrying it would redo nothing.
  const retryable = run.deferred === null && canRetryRun(run, others);
  const where = [projectTitle, taskNumber !== null ? `#${taskNumber}` : null].filter(Boolean).join(" ");
  return (
    <li className="text-xs">
      <div className="flex gap-2.5 px-3 py-2.5 sm:px-4">
        {selecting ? (
          <input
            type="checkbox"
            aria-label={`Select the run ${run.id}`}
            className="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-primary"
            checked={checked}
            disabled={disabled}
            onChange={(event) => onCheckedChange(event.currentTarget.checked)}
          />
        ) : null}
        <button
          type="button"
          aria-expanded={open}
          className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onOpenChange(!open)}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <Badge variant={runStatusVariant(run.status, run.deferred)} size="sm">
                {runStatusLabel(run)}
              </Badge>
              <span className="min-w-0 truncate font-medium text-foreground">{automation}</span>
              {where ? <span className="min-w-0 truncate text-muted-foreground">· {where}</span> : null}
            </span>
            {run.error ? (
              <span className="text-destructive-foreground [overflow-wrap:anywhere]">{run.error}</span>
            ) : summary ? (
              <span className="text-muted-foreground [overflow-wrap:anywhere]">{summary}</span>
            ) : null}
          </span>
          <span className="flex shrink-0 items-center gap-2 tabular-nums text-secondary-label">
            {cost ? <span className="hidden sm:inline">{cost}</span> : null}
            <span title={new Date(at).toLocaleString()}>{formatElapsedDurationLabel(at)}</span>
          </span>
        </button>
        {retryable ? <RetryButton runId={run.id} /> : null}
      </div>
      {open ? <RunDetail run={run} automation={automation} summary={summary} cost={cost} /> : null}
    </li>
  );
}

function RunDetail({
  run,
  automation,
  summary,
  cost,
}: {
  run: AutopilotRun;
  automation: string;
  summary: string;
  cost: string | null;
}) {
  const answer = scheduledAnswerOf(run);
  const model = run.model ? [run.model.provider, run.model.model, run.model.effort].filter(Boolean).join(" · ") : null;
  const rows: Array<[string, ReactNode]> = [];
  if (run.error && summary) rows.push(["Summary", summary]);
  if (run.dryRun) rows.push(["Dry run", "Recorded what it would do; nothing was done."]);
  if (cost) rows.push(["Cost", cost]);
  if (model) rows.push(["Model", model]);
  if (run.runner) rows.push(["Runner", run.runner]);
  if (run.exitCode !== null) rows.push(["Exit code", String(run.exitCode)]);
  if (run.sessionId)
    rows.push([
      "Session",
      <span key="sessionId" className="font-mono">
        {run.sessionId}
      </span>,
    ]);
  if (run.worktreePath)
    rows.push([
      "Worktree",
      <span key="worktreePath" className="font-mono">
        {run.worktreePath}
      </span>,
    ]);
  rows.push(["Started", new Date(run.startedAt ?? run.createdAt).toLocaleString()]);
  if (run.finishedAt) rows.push(["Finished", new Date(run.finishedAt).toLocaleString()]);
  rows.push([
    "Run id",
    <span key="id" className="font-mono">
      {run.id}
    </span>,
  ]);
  return (
    <div className="flex flex-col gap-2.5 px-3 pb-3 ps-9 text-muted-foreground sm:px-4 sm:ps-10">
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt>{label}</dt>
            <dd className="text-foreground/85 [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      {run.detail ? (
        <Block title={run.dryRun ? "What it would run" : run.status === "failed" ? "Error output" : "Output"}>
          {run.detail}
        </Block>
      ) : null}
      {answer ? <Block title="Handover">{answer.handover || "Nothing passed on."}</Block> : null}
      <div className="flex flex-wrap gap-1.5">
        {run.threadUrl && isOpenable(run.threadUrl) ? (
          <Button
            size="xs"
            variant="outline"
            render={
              <a href={run.threadUrl} {...(isWebUrl(run.threadUrl) ? { target: "_blank", rel: "noreferrer" } : {})} />
            }
          >
            Open thread
            <ExternalLinkIcon />
          </Button>
        ) : null}
        {run.status === "failed" ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => void copyFixPrompt(fixAutomationPrompt(automation, [run]))}
            title="Copies a prompt with this run's error and output, for an agent session"
          >
            Ask an agent to fix
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs font-medium uppercase tracking-wide">{title}</span>
      <pre className="max-h-56 overflow-auto rounded-md bg-muted/60 px-2 py-1.5 font-mono text-2xs whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground/85">
        {children}
      </pre>
    </div>
  );
}

/** Frees the run's work for the engine's next pass, which acts again if there is still work to do. */
function RetryButton({ runId }: { runId: string }) {
  const retry = useRetryAutopilotRun();
  return (
    <Button
      size="xs"
      variant="outline"
      className="shrink-0 self-start"
      disabled={retry.isPending}
      title="Let Autopilot try this again on its next pass"
      onClick={() => retry.mutate(runId)}
    >
      Retry
    </Button>
  );
}
