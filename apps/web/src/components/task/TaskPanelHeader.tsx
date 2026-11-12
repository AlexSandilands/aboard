import { TASK_STATUSES, type TaskDetail } from "@repo/contracts";
import type { ReactNode } from "react";
import { ArchiveIcon, Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";

import { AutopilotEpicButton } from "~/components/autopilot/AutopilotEpicButton";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { useShortcutLabel } from "~/components/layout/useKeybindings";
import { Kbd } from "~/components/ui/kbd";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useSetTaskExpanded } from "~/components/board/boardNavigation";
import { useUpdateTask } from "~/state/mutations";
import { EpicDeliveryButton, OnEpicBranchChip } from "./EpicDelivery";
import { importPendingLabel } from "./import.logic";
import { resolutionLabel } from "./resolution.logic";
import type { TaskPanelLayout } from "./sections.logic";
import { SectionsMenu } from "./SectionsMenu";
import { useSetTaskStatus } from "./useSetTaskStatus";

const STATUS_ITEMS = TASK_STATUSES.map((s) => ({ value: s.value, label: s.label }));
const STATUS_LABEL = Object.fromEntries(TASK_STATUSES.map((s) => [s.value, s.label])) as Record<
  TaskDetail["status"],
  string
>;

/** Top bar classes, shared with the loading skeleton so the layout doesn't shift. */
export const PANEL_TOP_BAR_CLASS =
  "drag-region flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 border-b border-border ps-2.5 pe-3 wco:pe-(--workspace-native-controls-inset)";

/**
 * The task window's top bar. No drag region: the window floats over the app. Full screen in the desktop shell (below
 * `sm`), it pads past the native window controls.
 */
export const WINDOW_TOP_BAR_CLASS =
  "flex h-12 shrink-0 items-center gap-2 border-b border-border ps-4 pe-2 max-sm:wco:pe-(--workspace-native-controls-inset)";

/** An icon button in the top bar with a tooltip naming it and, when it has one, its key. */
function TopBarButton({
  label,
  shortcut,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string | null;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} />}>
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        <span className="flex items-center gap-2">
          {label}
          {shortcut ? <Kbd>{shortcut}</Kbd> : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Close sits at the start of the bar: the end belongs to the native window controls, and an X
 * next to the window's own X is easy to mistake for it.
 */
export function ClosePanelButton({ onClose }: { onClose: () => void }) {
  const backShortcut = useShortcutLabel("back");
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Close panel" onClick={onClose} />}>
          <XIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          <span className="flex items-center gap-2">
            Close panel
            {backShortcut ? <Kbd>{backShortcut}</Kbd> : null}
          </span>
        </TooltipPopup>
      </Tooltip>
      <Separator orientation="vertical" className="h-4" />
    </>
  );
}

/**
 * The top bar: number, status, badges and the sections menu. In the docked panel Close sits at the start and Expand
 * at the end; in the task window (`layout="window"`) Dock and Close both sit at the end, as in the app's other
 * windows.
 */
export function TaskPanelHeader({
  task,
  layout = "panel",
  onClose,
  onDock,
  onOpenPlanEditor,
}: {
  task: TaskDetail;
  layout?: TaskPanelLayout;
  onClose: () => void;
  /** The window's Dock: back to the docked panel. */
  onDock?: () => void;
  onOpenPlanEditor: () => void;
}) {
  const { mutate: updateTask } = useUpdateTask();
  const setExpanded = useSetTaskExpanded();
  const inWindow = layout === "window";
  const expandShortcut = useShortcutLabel("panel.expand");
  const setStatus = useSetTaskStatus(task, onOpenPlanEditor);
  const resolution = resolutionLabel(task);
  const fetching = importPendingLabel(task);
  const hasPlan = task.progress.total > 0;
  const archived = task.archivedAt !== null;

  return (
    <header className={inWindow ? WINDOW_TOP_BAR_CLASS : PANEL_TOP_BAR_CLASS}>
      {inWindow ? null : <ClosePanelButton onClose={onClose} />}
      <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">#{task.number}</span>
      {task.kind === "epic" ? (
        // An epic's column follows its tasks, so there is nothing to pick.
        <Tooltip>
          <TooltipTrigger render={<span className="shrink-0 px-1.5 text-xs text-foreground/80" />}>
            Epic · {STATUS_LABEL[task.status]}
          </TooltipTrigger>
          <TooltipPopup side="bottom">Sits where its furthest-back open task is; Done once they all are</TooltipPopup>
        </Tooltip>
      ) : (
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
              const gated = !hasPlan && status.value !== "backlog";
              return (
                <SelectItem key={status.value} value={status.value} disabled={gated}>
                  {status.label}
                  {gated ? <span className="text-muted-foreground"> · needs a plan</span> : null}
                </SelectItem>
              );
            })}
          </SelectPopup>
        </Select>
      )}
      {resolution ? (
        <Badge variant="secondary" size="sm">
          {resolution}
        </Badge>
      ) : null}
      <OnEpicBranchChip task={task} />
      {archived ? (
        <Badge variant="warning" size="sm">
          Archived
        </Badge>
      ) : null}
      {fetching ? (
        <span className="flex min-w-0 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner size="xs" />
          {fetching}
        </span>
      ) : null}
      <div className="ms-auto flex items-center gap-1.5">
        {task.status === "done" && !archived && task.kind !== "epic" ? (
          <Button variant="outline" size="xs" onClick={() => updateTask({ id: task.id, archived: true })}>
            <ArchiveIcon />
            Archive
          </Button>
        ) : null}
        {task.kind === "epic" ? <EpicDeliveryButton epic={task} /> : null}
        {task.kind === "epic" ? <AutopilotEpicButton epic={task} /> : null}
        <SectionsMenu layout={layout} />
        {inWindow ? (
          <>
            <TopBarButton label="Dock to the side" shortcut={expandShortcut} onClick={() => onDock?.()}>
              <Minimize2Icon />
            </TopBarButton>
            <TopBarButton label="Close task" onClick={onClose}>
              <XIcon />
            </TopBarButton>
          </>
        ) : (
          <TopBarButton label="Open in window" shortcut={expandShortcut} onClick={() => void setExpanded(true)}>
            <Maximize2Icon />
          </TopBarButton>
        )}
      </div>
    </header>
  );
}
