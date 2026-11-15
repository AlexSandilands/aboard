import type { TaskSummary } from "@repo/contracts";
import { Badge } from "~/components/ui/badge";
import { holdLabel, holdTitle } from "./hold.logic";

/** Says a connected machine holds the task, and when edits made here are still waiting for it. Nothing otherwise. */
export function HoldBadge({ task }: { task: Pick<TaskSummary, "hold"> }) {
  if (!task.hold) return null;
  return (
    <Badge variant={task.hold.waiting > 0 ? "warning" : "outline"} size="sm" title={holdTitle(task.hold)}>
      {holdLabel(task.hold)}
    </Badge>
  );
}
