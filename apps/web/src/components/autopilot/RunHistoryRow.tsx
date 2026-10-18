import type { AutopilotRun } from "@repo/contracts";
import { Badge } from "~/components/ui/badge";
import { formatElapsedDurationLabel } from "~/lib/timestampFormat";
import { formatCost, runStatusLabel, runStatusVariant, scheduledAnswerOf } from "./autopilot.logic";

/**
 * One run in the history page: its status, where it ran, when, what it said it did (a scheduled agent's answer, with
 * the handover it left for the next run folded away) and, for a failed one, why. Ticking it selects it for deleting.
 */
export function RunHistoryRow({
  run,
  automation,
  projectTitle,
  taskNumber,
  checked,
  onCheckedChange,
}: {
  run: AutopilotRun;
  /** The automation's title, shown when the list mixes automations; null when the page is about one. */
  automation: string | null;
  projectTitle: string | null;
  /** The run's task, when the board still has it. */
  taskNumber: number | null;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const answer = scheduledAnswerOf(run);
  const at = run.finishedAt ?? run.startedAt ?? run.createdAt;
  const cost = formatCost(run.costUsd);
  const summary = answer?.summary || run.summary;
  return (
    <li className="flex gap-2.5 px-3 py-2.5 text-xs sm:px-4">
      <input
        type="checkbox"
        aria-label={`Select the run ${run.id}`}
        className="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-primary"
        checked={checked}
        onChange={(event) => onCheckedChange(event.currentTarget.checked)}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <Badge variant={runStatusVariant(run.status)} size="sm">
            {runStatusLabel(run)}
          </Badge>
          {automation ? <span className="shrink-0 text-muted-foreground">{automation}</span> : null}
          {projectTitle ? (
            <span className="min-w-0 truncate font-medium text-foreground/80">{projectTitle}</span>
          ) : null}
          {taskNumber !== null ? (
            <span className="shrink-0 tabular-nums text-muted-foreground">#{taskNumber}</span>
          ) : null}
          {cost ? <span className="shrink-0 tabular-nums text-muted-foreground">{cost}</span> : null}
          <span className="ms-auto shrink-0 tabular-nums text-secondary-label" title={new Date(at).toLocaleString()}>
            {formatElapsedDurationLabel(at)}
          </span>
        </div>
        {run.error ? <p className="text-destructive-foreground [overflow-wrap:anywhere]">{run.error}</p> : null}
        {summary ? <p className="text-muted-foreground [overflow-wrap:anywhere]">{summary}</p> : null}
        {answer ? (
          <details className="text-2xs text-muted-foreground">
            <summary className="w-fit cursor-pointer rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              Handover
            </summary>
            <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted/60 px-2 py-1.5 font-mono whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground/85">
              {answer.handover || "Nothing passed on."}
            </pre>
          </details>
        ) : null}
      </div>
    </li>
  );
}
