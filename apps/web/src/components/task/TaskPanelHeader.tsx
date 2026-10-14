import { TASK_STATUSES, type TaskDetail } from "@repo/contracts";
import { ArchiveIcon, XIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useUpdateTask } from "~/state/mutations";
import { resolutionLabel } from "./resolution.logic";
import { useSetTaskStatus } from "./useSetTaskStatus";

const STATUS_ITEMS = TASK_STATUSES.map((s) => ({ value: s.value, label: s.label }));

/** Top bar classes, shared with the loading skeleton so the layout doesn't shift. */
export const PANEL_TOP_BAR_CLASS =
  "drag-region flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 border-b border-border ps-2.5 pe-3 wco:pe-(--workspace-native-controls-inset)";

/**
 * Close sits at the start of the bar: the end belongs to the native window controls, and an X
 * next to the window's own X is easy to mistake for it.
 */
export function ClosePanelButton({ onClose }: { onClose: () => void }) {
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Close panel" onClick={onClose} />}>
          <XIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          <span className="flex items-center gap-2">
            Close panel
            <Kbd>Esc</Kbd>
          </span>
        </TooltipPopup>
      </Tooltip>
      <Separator orientation="vertical" className="h-4" />
    </>
  );
}

export function TaskPanelHeader({
  task,
  onClose,
  onOpenPlanEditor,
}: {
  task: TaskDetail;
  onClose: () => void;
  onOpenPlanEditor: () => void;
}) {
  const { mutate: updateTask } = useUpdateTask();
  const setStatus = useSetTaskStatus(task, onOpenPlanEditor);
  const resolution = resolutionLabel(task);
  const hasPlan = task.progress.total > 0;
  const archived = task.archivedAt !== null;

  return (
    <header className={PANEL_TOP_BAR_CLASS}>
      <ClosePanelButton onClose={onClose} />
      <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">#{task.number}</span>
      <Select
        value={task.status}
        items={STATUS_ITEMS}
        onValueChange={(value) => {
          if (value) setStatus(value);
        }}
      >
        <SelectTrigger variant="ghost" size="xs" aria-label="Status">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false} matchTriggerWidth={false}>
          {STATUS_ITEMS.map((status) => {
            const gated = !hasPlan && status.value !== "idea";
            return (
              <SelectItem key={status.value} value={status.value} disabled={gated}>
                {status.label}
                {gated ? <span className="text-muted-foreground"> · needs a plan</span> : null}
              </SelectItem>
            );
          })}
        </SelectPopup>
      </Select>
      {resolution ? (
        <Badge variant="secondary" size="sm">
          {resolution}
        </Badge>
      ) : null}
      {archived ? (
        <Badge variant="warning" size="sm">
          Archived
        </Badge>
      ) : null}
      {task.status === "done" && !archived ? (
        <Button
          variant="outline"
          size="xs"
          className="ms-auto"
          onClick={() => updateTask({ id: task.id, archived: true })}
        >
          <ArchiveIcon />
          Archive
        </Button>
      ) : null}
    </header>
  );
}
