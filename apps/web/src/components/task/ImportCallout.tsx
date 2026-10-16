import type { TaskDetail } from "@repo/contracts";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { useRetryImport } from "~/state/mutations";
import { importFailure, importPendingLabel, importSourceLabel } from "./import.logic";

/** Shows a task's import while it runs, and why it failed with a Retry. Renders nothing otherwise. */
export function ImportCallout({ task }: { task: TaskDetail }) {
  const { mutate: retry, isPending } = useRetryImport();
  const pending = importPendingLabel(task);
  const failure = importFailure(task);
  if (!pending && !failure) return null;
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
      ) : (
        <>
          <Spinner size="md" tone="muted" className="mt-0.5 shrink-0" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-semibold text-foreground/90">{pending}</span>
            <span className="text-muted-foreground">
              Reading {importSourceLabel(task.import!.sourceUrl)} to fill in the title, description and labels.
            </span>
          </div>
        </>
      )}
    </div>
  );
}
