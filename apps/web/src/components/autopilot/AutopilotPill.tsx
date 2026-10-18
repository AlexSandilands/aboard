import { AUTOPILOT_ORCHESTRATE, type Project } from "@repo/contracts";
import { PauseIcon, ZapIcon } from "lucide-react";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useSetAutopilotScope } from "~/state/mutations";
import { useNow } from "~/hooks/useNow";
import {
  useAutopilotOverview,
  useAutopilotScope,
  useAutopilotStatus,
  useProjectHasOrchestrateWork,
} from "~/state/queries";
import { useBoardView } from "~/state/ui";
import { pillState, pillTooltip, projectActiveRuns, type PillState } from "./autopilot.logic";
import { formatPillCountdown, pillTimerAt } from "./orchestrate.logic";
import { ScopePopover } from "./ScopePopover";

/** Border, fill and text per state; the epic button wears them too. */
export const PILL_CLASS_NAME: Record<PillState, string> = {
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

/** The pill's icon, or the epic button's whole content. */
export function PillIcon({ state }: { state: PillState }) {
  return state === "paused" ? (
    <PauseIcon className="size-3" />
  ) : (
    <ZapIcon className={cn("autopilot-pill-icon size-3", state === "active" && "text-primary")} />
  );
}

/** The pill's icon and label, with Orchestrate's countdown after it when there is one ("Autopilot · 12m"). */
export function PillLabel({ state, timer }: { state: PillState; timer?: string | null }) {
  return (
    <>
      <PillIcon state={state} />
      Autopilot
      {timer ? <span className="text-muted-foreground tabular-nums">· {timer}</span> : null}
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
  const boardScope = useAutopilotScope(null);
  const set = useSetAutopilotScope(project.id);
  const hasWork = useProjectHasOrchestrateWork(project.id);
  const showTimer = useBoardView((s) => s.showAutopilotTimer);
  const orchestrateOn =
    showTimer && Boolean(scope.data?.some((e) => e.automation === AUTOPILOT_ORCHESTRATE && e.enabled));
  // Minutes are all the pill shows, so a few ticks a minute keep it close enough.
  const now = useNow(15_000, orchestrateOn);
  if (!overview.data || overview.data.automations.length === 0) return null;

  const state = pillState(status, project.id, scope.data);
  const activeRuns = projectActiveRuns(status, project.id);
  const active = activeRuns.length;
  const timerAt = orchestrateOn
    ? pillTimerAt({
        entries: scope.data,
        paused: status?.paused,
        running: activeRuns.some((r) => r.automation === AUTOPILOT_ORCHESTRATE),
        engine: overview.data.engine,
        hasWork,
        now,
      })
    : null;
  const timer = timerAt ? formatPillCountdown(timerAt.getTime() - now.getTime()) : null;
  const tooltip = pillTooltip(state, active) + (timer ? ` · Orchestrate's next check in ${timer}` : "");
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              data-autopilot-state={state}
              aria-label={`Autopilot for ${project.title}: ${tooltip}`}
              className={pillClassName(state)}
            />
          }
        >
          <PillLabel state={state} timer={timer} />
        </TooltipTrigger>
        <TooltipPopup>{tooltip}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" width="lg" padding="compact">
        <ScopePopover
          title={project.title}
          entries={scope.data}
          parentEntries={boardScope.data}
          set={set}
          projectId={project.id}
        />
      </PopoverPopup>
    </Popover>
  );
}
