import { canRetryRun, type AutopilotRun, type TaskDetail } from "@repo/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { isWebUrl } from "~/components/task/links.logic";
import { TaskSection } from "~/components/task/TaskSection";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { formatElapsedDurationLabel } from "~/lib/timestampFormat";
import { useRetryAutopilotRun } from "~/state/mutations";
import { useAutopilotOverview, useAutopilotRuns } from "~/state/queries";
import { automationTitle, formatCost, runStatusLabel, runStatusVariant } from "./autopilot.logic";

/**
 * The runs Autopilot has made on this task, newest first: what it did, how it ran, where to follow it and what it
 * cost. Left out while there are none, so the panel stays clean for tasks Autopilot never touched.
 */
export function AutopilotSection({ task }: { task: TaskDetail }) {
  const runs = useAutopilotRuns({ taskId: task.id }).data;
  const automations = useAutopilotOverview().data?.automations ?? [];
  if (!runs?.length) return null;
  // Newest first. A run that needs attention is what the card and the collapsed text point at, so it comes first.
  const shown = runs.find((run) => run.needsAttention) ?? runs[0]!;
  return (
    <TaskSection
      title="Autopilot"
      summary={
        <Badge
          variant={runStatusVariant(shown.status)}
          size="sm"
          title={automationTitle(automations, shown.automation)}
        >
          {runStatusLabel(shown)}
        </Badge>
      }
    >
      <ul className="flex flex-col gap-1 px-1.5">
        {runs.map((run) => (
          <RunRow
            key={run.id}
            run={run}
            title={automationTitle(automations, run.automation)}
            retryable={canRetryRun(run, runs)}
          />
        ))}
      </ul>
    </TaskSection>
  );
}

/** Web URLs and T3 Code deep links; a runner's thread URL is shown as a link only if it is one of those. */
const isOpenable = (url: string) => isWebUrl(url) || url.startsWith("t3code://");

function RunRow({ run, title, retryable }: { run: AutopilotRun; title: string; retryable: boolean }) {
  const cost = formatCost(run.costUsd);
  const at = run.finishedAt ?? run.startedAt ?? run.createdAt;
  return (
    <li className="flex flex-col gap-0.5 rounded-md px-1 py-1">
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <Badge variant={runStatusVariant(run.status)} size="sm">
          {runStatusLabel(run)}
        </Badge>
        <span className="min-w-0 truncate font-medium text-foreground/90">{title}</span>
        <span className="ms-auto shrink-0 tabular-nums text-secondary-label" title={new Date(at).toLocaleString()}>
          {formatElapsedDurationLabel(at)}
        </span>
      </div>
      {run.summary ? <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{run.summary}</p> : null}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-2xs text-muted-foreground">
        {run.runner ? <span>{run.runner}</span> : null}
        {run.threadUrl && isOpenable(run.threadUrl) ? (
          <a
            href={run.threadUrl}
            {...(isWebUrl(run.threadUrl) ? { target: "_blank", rel: "noreferrer" } : {})}
            className="inline-flex items-center gap-0.5 rounded-sm underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open thread
            <ExternalLinkIcon className="size-3" />
          </a>
        ) : null}
        {run.sessionId ? (
          <span className="min-w-0 truncate font-mono" title={`Session ${run.sessionId}`}>
            session {run.sessionId}
          </span>
        ) : null}
        {cost ? <span className="tabular-nums">{cost}</span> : null}
        {run.exitCode !== null ? <span className="tabular-nums">exit {run.exitCode}</span> : null}
        {retryable ? <RetryButton runId={run.id} /> : null}
      </div>
      {run.error ? <p className="text-xs text-destructive-foreground [overflow-wrap:anywhere]">{run.error}</p> : null}
      {run.detail ? (
        <details className="text-2xs text-muted-foreground">
          <summary className="w-fit cursor-pointer rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            {run.dryRun ? "What it would run" : "Output"}
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted/60 px-2 py-1.5 font-mono whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground/85">
            {run.detail}
          </pre>
        </details>
      ) : null}
    </li>
  );
}

/** Frees the run's work for the engine's next pass, which acts again if there is still work to do. */
function RetryButton({ runId }: { runId: string }) {
  const retry = useRetryAutopilotRun();
  return (
    <Button
      size="xs"
      variant="ghost"
      className="ms-auto"
      disabled={retry.isPending}
      title="Let Autopilot try this again on its next pass"
      onClick={() => retry.mutate(runId)}
    >
      Retry
    </Button>
  );
}
