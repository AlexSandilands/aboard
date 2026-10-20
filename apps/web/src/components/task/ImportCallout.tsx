import type { TaskDetail } from "@repo/contracts";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { useRetryImport } from "~/state/mutations";
import { useSettings } from "~/state/queries";
import { epicImportProgress, importFailure, importPendingLabel, importSourceLabel } from "./import.logic";

/**
 * Shows a task's import while it runs, and why it failed with a Retry; for an imported epic, how far its tasks'
 * imports have got. Renders nothing otherwise.
 */
export function ImportCallout({ task }: { task: TaskDetail }) {
  const { mutate: retry, isPending } = useRetryImport();
  const pending = importPendingLabel(task);
  const ticketSystems = useSettings().data?.ticketSystems ?? [];
  const failure = importFailure(task, ticketSystems);
  const epicProgress = epicImportProgress(task);
  if (!pending && !failure && !epicProgress) return null;
  return (
    <div className="flex min-w-0 items-start gap-2.5 rounded-xl border border-border/60 bg-card/40 p-3 text-sm">
      {failure ? (
        <>
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-semibold text-foreground/90">{failure.title}</span>
            <span className="text-muted-foreground [overflow-wrap:anywhere]">{failure.reason}</span>
            <span className="text-xs text-muted-foreground/80">The task is usable as it is.</span>
          </div>
          <Button size="xs" variant="outline" disabled={isPending} onClick={() => retry(task.id)}>
            {isPending ? <Spinner /> : <RefreshCwIcon />}
            Retry
          </Button>
        </>
      ) : pending ? (
        <>
          <Spinner size="md" tone="muted" className="mt-0.5 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-semibold text-foreground/90">{pending}</span>
            <span className="text-muted-foreground">
              Reading {importSourceLabel(task.import!.sourceUrl, ticketSystems)} to fill in the title, description and
              labels.
            </span>
          </div>
          {/* An import can be left pending with nothing running it (its task was archived over a restart). */}
          <Button
            size="xs"
            variant="ghost"
            title="Start the import again if it seems stuck"
            disabled={isPending}
            onClick={() => retry(task.id)}
          >
            Retry
          </Button>
        </>
      ) : (
        <>
          <Spinner size="md" tone="muted" className="mt-0.5 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-semibold text-foreground/90">
              Importing the epic&apos;s tasks: {epicProgress!.done} of {epicProgress!.total}
            </span>
            <span className="text-muted-foreground">
              {importSourceLabel(task.import!.sourceUrl, ticketSystems)} is an epic. Each of its tasks fills in its
              details as its issue is read.
            </span>
          </div>
        </>
      )}
    </div>
  );
}
