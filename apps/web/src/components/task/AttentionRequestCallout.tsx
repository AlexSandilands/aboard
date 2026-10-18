import type { TaskDetail } from "@repo/contracts";
import { XIcon } from "lucide-react";

import { AttentionIcon } from "~/components/board/attention";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { formatRelativeTimeLabel } from "~/lib/timestampFormat";
import { useDismissAttentionRequest } from "~/state/mutations";

/** What an agent asked the user to look at, with a Dismiss. Renders nothing when no agent has asked. */
export function AttentionRequestCallout({ task }: { task: TaskDetail }) {
  const { mutate: dismiss, isPending } = useDismissAttentionRequest();
  const request = task.attentionRequest;
  if (!request) return null;
  return (
    <div className="flex min-w-0 items-start gap-2.5 rounded-xl border border-border/60 bg-card/40 p-3 text-sm">
      <AttentionIcon severity="warning" className="mt-0.5 size-4" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-semibold text-foreground/90">
          {request.actor} asked you to look at this
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">
            {formatRelativeTimeLabel(request.requestedAt)}
          </span>
        </span>
        <span className="whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{request.message}</span>
      </div>
      <Button size="xs" variant="outline" disabled={isPending} onClick={() => dismiss(task.id)}>
        {isPending ? <Spinner /> : <XIcon />}
        Dismiss
      </Button>
    </div>
  );
}
