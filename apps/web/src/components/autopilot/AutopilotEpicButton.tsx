import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useSetAutopilotScope } from "~/state/mutations";
import { useAutopilotEpicScope, useAutopilotOverview, useAutopilotScope, useAutopilotStatus } from "~/state/queries";
import { epicActiveRuns, epicPillState, pillTooltip } from "./autopilot.logic";
import { PILL_CLASS_NAME, PillIcon } from "./AutopilotPill";
import { ScopePopover } from "./ScopePopover";

/**
 * The Autopilot button on an epic's band and in its panel: the lane pill's three states and its sweep while a run
 * on one of the epic's tasks is going, as a small circle. Opens the epic's switches, whose Inherit follows the
 * project. Nothing shows while the catalogue is empty, nor for an archived epic (it no longer counts as a scope).
 */
export function AutopilotEpicButton({
  epic,
  className,
}: {
  epic: { id: string; number: number; projectId: string; archivedAt: string | null };
  className?: string;
}) {
  const overview = useAutopilotOverview();
  const status = useAutopilotStatus();
  const scope = useAutopilotEpicScope(epic.projectId, epic.id);
  const projectScope = useAutopilotScope(epic.projectId);
  const set = useSetAutopilotScope(epic.projectId, undefined, epic.id);
  if (!overview.data || overview.data.automations.length === 0 || epic.archivedAt !== null) return null;

  const state = epicPillState(status, epic.id, scope.data);
  const active = epicActiveRuns(status, epic.id).length;
  const tooltip = pillTooltip(state, active, "epic");
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              data-autopilot-state={state}
              aria-label={`Autopilot for epic #${epic.number}: ${tooltip}`}
              className={cn(
                "autopilot-pill inline-flex size-5.5 shrink-0 cursor-pointer items-center justify-center rounded-full border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                PILL_CLASS_NAME[state],
                className,
              )}
            />
          }
        >
          <PillIcon state={state} />
        </TooltipTrigger>
        <TooltipPopup>{tooltip}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" width="lg" padding="compact">
        <ScopePopover title={`epic #${epic.number}`} entries={scope.data} parentEntries={projectScope.data} set={set} />
      </PopoverPopup>
    </Popover>
  );
}
