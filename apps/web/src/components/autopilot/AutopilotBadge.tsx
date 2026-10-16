import type { AutopilotActiveRun } from "@repo/contracts";
import { Badge } from "~/components/ui/badge";
import { Spinner } from "~/components/ui/spinner";
import { useAutopilotOverview, useTaskActiveRun } from "~/state/queries";
import { automationTitle } from "./autopilot.logic";

/** On a card while an Autopilot run is working on the task. */
export function AutopilotBadge({ taskId }: { taskId: string }) {
  const run = useTaskActiveRun(taskId);
  return run ? <ActiveRunBadge run={run} /> : null;
}

// Split out so only cards with a run in flight read the catalogue for the title.
function ActiveRunBadge({ run }: { run: AutopilotActiveRun }) {
  const automations = useAutopilotOverview().data?.automations ?? [];
  const title = automationTitle(automations, run.automation);
  return (
    <Badge variant="info" size="sm" title={`Autopilot ${run.status === "queued" ? "queued" : "is running"}: ${title}`}>
      <Spinner size="xs" aria-hidden role="presentation" />
      Autopilot
    </Badge>
  );
}
