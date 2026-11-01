import type { Project, TaskDetail } from "@repo/contracts";
import { EllipsisIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";
import { Menu, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { canStartT3Thread, showHandoffActions } from "~/components/handoff/handoff.logic";
import { HandoffMenu } from "~/components/handoff/HandoffActions";
import { useBoard, useSettings } from "~/state/queries";
import { useTaskPanelPrefs } from "~/state/ui";
import { normalizePins, pinnedButtons } from "./taskActions.logic";
import { TaskMenuItems, useTaskMenuActions, type ActionDef } from "./TaskMenuItems";

/** Hand-off buttons, pinned actions and the More menu, shown beside the task title. */
export function TaskActions({
  task,
  projects,
  onClose,
  onOpenPlanEditor,
}: {
  task: TaskDetail;
  projects: ReadonlyArray<Project>;
  onClose: () => void;
  onOpenPlanEditor: () => void;
}) {
  const storedPins = useTaskPanelPrefs((s) => s.pinnedActions);
  const togglePinnedAction = useTaskPanelPrefs((s) => s.togglePinnedAction);
  const board = useBoard().data;
  const t3 = board?.integrations.t3;
  const settings = useSettings().data;
  const taskProject = projects.find((p) => p.id === task.projectId);
  const handoff = showHandoffActions(task);
  const startT3 = handoff && !!t3 && canStartT3Thread(task, taskProject, t3, settings);
  const actions = useTaskMenuActions(task, onOpenPlanEditor);
  const pins = normalizePins(storedPins);

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {pinnedButtons(pins, task).map((id) => (
        <PinnedButton key={id} action={actions[id]} />
      ))}
      {handoff ? <HandoffMenu task={task} variant="panel" canStartT3={startT3} /> : null}
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={<MenuTrigger render={<Button variant="ghost" size="icon" aria-label="More actions" />} />}
          >
            <EllipsisIcon />
          </TooltipTrigger>
          <TooltipPopup>More actions</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end">
          <TaskMenuItems
            task={task}
            detail={task}
            projects={projects}
            onOpenPlanEditor={onOpenPlanEditor}
            onDeleted={onClose}
            pins={{ pinned: pins, onToggle: togglePinnedAction }}
          />
        </MenuPopup>
      </Menu>
    </div>
  );
}

function PinnedButton({ action }: { action: ActionDef }) {
  const Icon = action.icon;
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon" aria-label={action.label} onClick={action.run} />}>
        <Icon />
      </TooltipTrigger>
      <TooltipPopup>
        <span className="flex items-center gap-2">
          {action.label}
          {action.shortcut ? <Kbd>{action.shortcut}</Kbd> : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}
