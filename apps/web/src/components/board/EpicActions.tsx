import type { TaskSummary } from "@repo/contracts";
import { canStartT3Thread, showHandoffActions } from "~/components/handoff/handoff.logic";
import { HandoffMenu } from "~/components/handoff/HandoffActions";
import { cn } from "~/lib/utils";
import { useBoardContext } from "./BoardContext";
import { CardLinks, hasCardLinks } from "./CardLinks";

/**
 * What a task card shows on its links line, for an epic's band header and Done card: the epic's threads and
 * sessions (to jump back to the one orchestrating it) and the start button.
 */
export function EpicActions({ epic, className }: { epic: TaskSummary; className?: string }) {
  const { t3, settings, projects } = useBoardContext();
  const handoff = showHandoffActions(epic);
  const startT3 =
    handoff &&
    canStartT3Thread(
      epic,
      projects.find((p) => p.id === epic.projectId),
      t3,
      settings,
    );
  // Threads and sessions only: an epic's own PR (its delivery branch's) is merged by the user, not from its header.
  const links = epic.links.filter((link) => link.kind !== "pr");
  const hasLinks = hasCardLinks(links);
  if (!hasLinks && !handoff) return null;
  return (
    <div className={cn("flex shrink-0 items-center gap-0.5", className)}>
      {hasLinks ? <CardLinks taskId={epic.id} taskStatus={epic.status} links={links} /> : null}
      {handoff ? <HandoffMenu task={epic} variant="card" canStartT3={startT3} /> : null}
    </div>
  );
}
