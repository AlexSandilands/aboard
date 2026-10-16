import type { Project } from "@repo/contracts";
import { PauseIcon, ZapIcon } from "lucide-react";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useSetAutopilotScope } from "~/state/mutations";
import { useAutopilotOverview, useAutopilotScope, useAutopilotStatus } from "~/state/queries";
import { useDialogs } from "~/state/ui";
import {
  entryFor,
  inheritLabel,
  parentEntry,
  pillState,
  pillTooltip,
  projectActiveRuns,
  type PillState,
} from "./autopilot.logic";
import { ModeSwitch } from "./ModeSwitch";

const PILL_CLASS_NAME: Record<PillState, string> = {
  off: "border-border/50 text-muted-foreground/55 hover:text-muted-foreground",
  idle: "border-primary/40 bg-primary/8 text-foreground/85 hover:bg-primary/14",
  paused: "border-warning/50 bg-warning/8 text-warning-foreground",
  active: "border-transparent bg-primary/10 text-foreground",
};

/** The pill's classes. Also used by the style gallery to show every state. */
export const pillClassName = (state: PillState) =>
  cn(
    "autopilot-pill inline-flex h-5.5 shrink-0 cursor-pointer items-center gap-1 rounded-full border px-2 text-2xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
    PILL_CLASS_NAME[state],
  );

/** The pill's icon and label. */
export function PillLabel({ state }: { state: PillState }) {
  return (
    <>
      {state === "paused" ? (
        <PauseIcon className="size-3" />
      ) : (
        <ZapIcon className={cn("autopilot-pill-icon size-3", state === "active" && "text-primary")} />
      )}
      Autopilot
    </>
  );
}

/**
 * The lane header's Autopilot pill: a lively sweep while a run is going in the project, a calm ring when it's on
 * and idle, dim when off. Opens the project's switches. Nothing shows while the catalogue is empty.
 */
export function AutopilotPill({ project }: { project: Project }) {
  const overview = useAutopilotOverview();
  const status = useAutopilotStatus();
  const scope = useAutopilotScope(project.id);
  if (!overview.data || overview.data.automations.length === 0) return null;

  const state = pillState(status, project.id, scope.data);
  const active = projectActiveRuns(status, project.id).length;
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              data-autopilot-state={state}
              aria-label={`Autopilot for ${project.title}: ${pillTooltip(state, active)}`}
              className={pillClassName(state)}
            />
          }
        >
          <PillLabel state={state} />
        </TooltipTrigger>
        <TooltipPopup>{pillTooltip(state, active)}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" width="lg" padding="compact">
        <AutopilotPopover project={project} />
      </PopoverPopup>
    </Popover>
  );
}

/** Inherit / On / Off per automation for one project, each saying what Inherit would be. */
function AutopilotPopover({ project }: { project: Project }) {
  const overview = useAutopilotOverview();
  const projectScope = useAutopilotScope(project.id);
  const boardScope = useAutopilotScope(null);
  const set = useSetAutopilotScope(project.id);
  const paused = overview.data?.paused ?? false;
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">Autopilot</h3>
        <PopoverClose
          className="cursor-pointer rounded-sm text-2xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => useDialogs.getState().setAppSettingsOpen(true)}
        >
          Settings
        </PopoverClose>
      </div>
      {paused ? (
        <p className="rounded-md bg-warning/8 px-2 py-1 text-2xs text-warning-foreground">
          Paused: no new runs start. Runs already going finish.
        </p>
      ) : null}
      <ul className="flex flex-col divide-y divide-border/50">
        {(overview.data?.automations ?? []).map((automation) => {
          const entry = entryFor(projectScope.data, automation);
          const parent = parentEntry(boardScope.data, automation.key);
          return (
            <li key={automation.key} className="flex flex-col gap-1.5 py-2 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">{automation.title}</p>
                <p className="line-clamp-2 text-2xs text-muted-foreground">{automation.description}</p>
              </div>
              <div className="flex items-center justify-between gap-2">
                <ModeSwitch
                  label={`${automation.title} in ${project.title}`}
                  value={entry.mode}
                  disabled={set.isPending}
                  onChange={(mode) => set.mutate({ automation: automation.key, mode })}
                />
                <span className="min-w-0 truncate text-2xs text-muted-foreground" title="What Inherit resolves to">
                  {inheritLabel(parent)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
