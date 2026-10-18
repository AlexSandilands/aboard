import type { AutopilotAutomation, AutopilotScopeEntry } from "@repo/contracts";
import { LoaderCircleIcon, PlayIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useNow } from "~/hooks/useNow";
import { cn } from "~/lib/utils";
import type { useSetAutopilotScope } from "~/state/mutations";
import { useRunOrchestrateNow } from "~/state/mutations";
import { useAutopilotOverview, useOrchestrateState } from "~/state/queries";
import { scopeRowModel } from "./autopilot.logic";
import { lastRunText, orchestrateLine } from "./orchestrate.logic";
import { RunHistoryLink } from "./RunHistoryLink";
import { ScopeCard, ScopeRow } from "./ScopeRow";

/**
 * Orchestrate's card at the top of a project's Autopilot popover: its row, then one line with the next check (or why
 * there won't be one) beside History and ▶ Run now. The latest run is that line's tooltip; the pill's countdown
 * switch is in Settings.
 */
export function OrchestrateSection({
  automation,
  entry,
  title,
  projectId,
  set,
}: {
  automation: AutopilotAutomation;
  entry: AutopilotScopeEntry;
  title: string;
  projectId: string;
  set: ReturnType<typeof useSetAutopilotScope>;
}) {
  const overview = useAutopilotOverview();
  const state = useOrchestrateState(projectId);
  const run = useRunOrchestrateNow(projectId);
  const now = useNow(1_000);
  const line = state.data ? orchestrateLine(state.data, overview.data?.engine, now) : null;
  const going = line?.kind === "running" || line?.kind === "requested" || run.isPending;
  return (
    <ScopeCard>
      <ScopeRow
        name={automation.title}
        description={automation.description}
        label={`${automation.title} in ${title}`}
        model={scopeRowModel(entry, automation.blocked, "project")}
        scope="project"
        disabled={set.isPending}
        onChange={(mode) => set.mutate({ automation: automation.key, mode })}
      />
      <div className="flex items-center gap-2 py-1.5">
        {state.data && line ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <p
                  aria-live="polite"
                  className={cn(
                    "min-w-0 flex-1 truncate text-2xs",
                    line.kind === "countdown" ? "text-foreground tabular-nums" : "text-muted-foreground",
                    line.kind === "running" && "text-info-foreground",
                  )}
                />
              }
            >
              {line.text}
            </TooltipTrigger>
            <TooltipPopup side="top">{lastRunText(state.data.lastRun)}</TooltipPopup>
          </Tooltip>
        ) : state.error ? (
          <p className="min-w-0 flex-1 truncate text-2xs text-destructive-foreground">{state.error.message}</p>
        ) : (
          <span className="flex-1" />
        )}
        <RunHistoryLink automation={automation.key} project={projectId} fromSettings={false} label="History" />
        {state.data?.enabled ? (
          <Button
            size="compact"
            variant="outline"
            disabled={going}
            aria-label={`Run ${automation.title} in ${title} now`}
            onClick={() => run.mutate()}
          >
            {going ? <LoaderCircleIcon className="animate-spin" /> : <PlayIcon />}
            {line?.kind === "running" ? "Running…" : "Run now"}
          </Button>
        ) : null}
      </div>
    </ScopeCard>
  );
}
