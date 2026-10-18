import { AUTOPILOT_ORCHESTRATE, type Project } from "@repo/contracts";
import { LoaderCircleIcon, PlayIcon } from "lucide-react";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { useNow } from "~/hooks/useNow";
import { cn } from "~/lib/utils";
import { useRunOrchestrateNow } from "~/state/mutations";
import { useAutopilotOverview, useBoard, useOrchestrateState } from "~/state/queries";
import { FieldRow, useScopeAutomations } from "./AutomationRows";
import { BOARD_MODES, boardModeToSave, boardSummary, boardSwitchValue } from "./autopilot.logic";
import { BlockedWarning } from "./InputsAndSlots";
import { ModeSwitch } from "./ModeSwitch";
import { lastRunText, orchestrateLine } from "./orchestrate.logic";
import { RunHistoryLink } from "./RunHistoryLink";

/**
 * Orchestrate's own area in Settings → Autopilot, above the list of the other automations: its board switch and
 * config, each project's next check, last run and Run now, and a link to its run history. Reads its own queries.
 */
export function OrchestrateSettings() {
  const { items, pending = false, rejected = 0 } = useScopeAutomations(null);
  const engine = useAutopilotOverview().data?.engine;
  const projects = useBoard().data?.projects.filter((p) => p.archivedAt === null) ?? [];
  const now = useNow(1_000);
  const item = items.find((i) => i.automation.key === AUTOPILOT_ORCHESTRATE);
  // While the catalogue loads (or fails) the Automations list below says so; there is nothing to show here yet.
  if (!item) return null;
  const { automation, entry, onMode, onConfig } = item;
  return (
    <SettingsSection id="autopilot.engine.orchestrate" title={automation.title}>
      <SettingsRow
        title={`${automation.title} for the board`}
        description={automation.description}
        status={boardSummary(entry.mode)}
        control={
          <ModeSwitch
            label={`${automation.title} for the board`}
            modes={BOARD_MODES}
            value={boardSwitchValue(entry.mode)}
            disabled={pending}
            blocked={automation.blocked}
            onChange={(mode) => onMode(boardModeToSave(mode))}
          />
        }
      >
        {automation.blocked ? (
          <div className="mt-2">
            <BlockedWarning reason={automation.blocked} />
          </div>
        ) : null}
      </SettingsRow>
      {automation.fields.map((field) => (
        <div key={field.key} className="@container/settings-row px-3 sm:px-4">
          <FieldRow
            automation={automation}
            field={field}
            entry={entry}
            projectId={null}
            rejected={rejected}
            onConfig={onConfig}
          />
        </div>
      ))}
      {projects.map((project) => (
        <ProjectCheck key={project.id} project={project} engine={engine} now={now} />
      ))}
      <SettingsRow
        title="Run history"
        description="Every run, with what it said it did and the handover it left. Searchable, and runs can be deleted there."
        control={<RunHistoryLink automation={AUTOPILOT_ORCHESTRATE} />}
      />
    </SettingsSection>
  );
}

/** One project's line: the next check (or why there won't be one), the latest run and Run now. */
function ProjectCheck({
  project,
  engine,
  now,
}: {
  project: Project;
  engine: Parameters<typeof orchestrateLine>[1];
  now: Date;
}) {
  const state = useOrchestrateState(project.id);
  const run = useRunOrchestrateNow(project.id);
  const line = state.data ? orchestrateLine(state.data, engine, now) : null;
  const going = line?.kind === "running" || line?.kind === "requested" || run.isPending;
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 sm:px-4">
      <div className="min-w-0 text-xs">
        <p className="truncate font-medium text-foreground/80">{project.title}</p>
        {state.data && line ? (
          <>
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
          </>
        ) : state.error ? (
          <p className="text-destructive-foreground">{state.error.message}</p>
        ) : (
          <p className="text-muted-foreground">Loading...</p>
        )}
      </div>
      {state.data?.enabled ? (
        <Button
          size="compact"
          variant="outline"
          disabled={going}
          aria-label={`Run Orchestrate in ${project.title} now`}
          onClick={() => run.mutate()}
        >
          {going ? <LoaderCircleIcon className="animate-spin" /> : <PlayIcon />}
          {line?.kind === "running" ? "Running…" : "Run now"}
        </Button>
      ) : null}
    </div>
  );
}
