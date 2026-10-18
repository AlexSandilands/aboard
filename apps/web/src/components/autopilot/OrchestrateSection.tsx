import type { AutopilotAutomation, AutopilotScopeEntry } from "@repo/contracts";
import { LoaderCircleIcon, PlayIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { useNow } from "~/hooks/useNow";
import { cn } from "~/lib/utils";
import type { useSetAutopilotScope } from "~/state/mutations";
import { useRunOrchestrateNow } from "~/state/mutations";
import { useAutopilotOverview, useOrchestrateState } from "~/state/queries";
import { useBoardView } from "~/state/ui";
import { inheritLabel } from "./autopilot.logic";
import { ModeSwitch } from "./ModeSwitch";
import { lastRunText, orchestrateLine } from "./orchestrate.logic";
import { RunHistoryLink } from "./RunHistoryLink";

/**
 * Orchestrate's pinned section at the top of a project's Autopilot popover: its switch, the next check (or why there
 * won't be one), the latest run, ▶ Run now, and the switch for the pill's timer.
 */
export function OrchestrateSection({
  automation,
  entry,
  parent,
  title,
  projectId,
  set,
}: {
  automation: AutopilotAutomation;
  entry: AutopilotScopeEntry;
  parent: AutopilotScopeEntry | null;
  title: string;
  projectId: string;
  set: ReturnType<typeof useSetAutopilotScope>;
}) {
  const overview = useAutopilotOverview();
  const state = useOrchestrateState(projectId);
  const run = useRunOrchestrateNow(projectId);
  const now = useNow(1_000);
  const showTimer = useBoardView((s) => s.showAutopilotTimer);
  const setShowTimer = useBoardView((s) => s.setShowAutopilotTimer);
  const line = state.data ? orchestrateLine(state.data, overview.data?.engine, now) : null;
  const going = line?.kind === "running" || line?.kind === "requested" || run.isPending;
  return (
    <section
      aria-label={`${automation.title} in ${title}`}
      className="flex flex-col gap-1.5 rounded-lg border border-primary/30 bg-primary/6 p-2"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium">{automation.title}</p>
          <p className="line-clamp-2 text-2xs text-muted-foreground">{automation.description}</p>
        </div>
        <RunHistoryLink automation={automation.key} project={projectId} fromSettings={false} label="View history" />
      </div>
      <div className="flex items-center justify-between gap-2">
        <ModeSwitch
          label={`${automation.title} in ${title}`}
          value={entry.mode}
          disabled={set.isPending}
          blocked={automation.blocked}
          onChange={(mode) => set.mutate({ automation: automation.key, mode })}
        />
        <span
          className={cn(
            "min-w-0 truncate text-2xs",
            entry.mode === "inherit" && parent?.enabled ? "text-info-foreground" : "text-muted-foreground",
          )}
          title="What Inherit resolves to"
        >
          {inheritLabel(parent)}
        </span>
      </div>
      {state.data && line ? (
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 text-2xs">
            <p
              aria-live="polite"
              className={cn(
                "truncate",
                line.kind === "countdown" ? "text-foreground tabular-nums" : "text-muted-foreground",
                line.kind === "running" && "text-info-foreground",
              )}
            >
              {line.text}
            </p>
            <p className="truncate text-muted-foreground/80">{lastRunText(state.data.lastRun)}</p>
          </div>
          {state.data.enabled ? (
            <Button
              size="compact"
              variant="outline"
              disabled={going}
              aria-label={`Run ${automation.title} in ${title} now`}
              onClick={() => run.mutate()}
            >
              {going ? <LoaderCircleIcon className="animate-spin" /> : <PlayIcon />}
              {line.kind === "running" ? "Running…" : "Run now"}
            </Button>
          ) : null}
        </div>
      ) : state.error ? (
        <p className="text-2xs text-destructive-foreground">{state.error.message}</p>
      ) : null}
      <div className="flex items-center justify-between gap-2 text-2xs text-muted-foreground">
        Countdown on the lane's pill
        <Switch
          size="sm"
          aria-label="Countdown on the lane's pill"
          checked={showTimer}
          onCheckedChange={setShowTimer}
        />
      </div>
    </section>
  );
}
