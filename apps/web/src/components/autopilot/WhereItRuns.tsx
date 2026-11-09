import {
  boardState,
  projectState,
  whereOffEverywhere,
  whereOnEverywhere,
  whereProject,
  whereProjectPreview,
  type AutopilotAutomation,
} from "@repo/contracts";
import { DetailSection } from "~/components/settings/agents/SplitCard";
import { Skeleton } from "~/components/ui/skeleton";
import { ProjectTable, type ProjectTableColumn } from "./ProjectTable";
import { draftHeader, draftRowOn, draftRowToggle, headerLoss, type DraftWhere } from "./where.logic";
import { useWhere } from "./useWhere";

/**
 * The detail pane's "Where it runs": one row per project under All projects. It writes the same board, project and
 * epic switches as the lane and epic popovers, so all three always agree.
 */
export function WhereItRuns({
  automation,
  everywhereMode = "on",
}: {
  automation: AutopilotAutomation;
  /** The mode the header turns an off automation on in: On, or Preview for one that has never run. */
  everywhereMode?: "on" | "preview";
}) {
  const where = useWhere(automation);
  return (
    <DetailSection title="Where it runs">
      {where.input && where.scopes ? (
        <LiveProjects automation={automation} everywhereMode={everywhereMode} where={where} flush />
      ) : (
        <div className="px-3 py-3 sm:px-4">
          <WhereLoading error={where.error} />
        </div>
      )}
    </DetailSection>
  );
}

function WhereLoading({ error }: { error: Error | null }) {
  return error ? (
    <p role="alert" className="text-xs text-destructive-foreground">
      Couldn&apos;t load where it runs: {error.message}
    </p>
  ) : (
    <div className="space-y-2">
      <Skeleton className="h-4 w-56" />
      <Skeleton className="h-7 w-44" />
    </div>
  );
}

/** The builder's Where step for a saved automation: the table, writing its switches as they change. */
export function WhereProjects({
  automation,
  everywhereMode = "preview",
}: {
  automation: AutopilotAutomation;
  everywhereMode?: "on" | "preview";
}) {
  const where = useWhere(automation);
  if (!where.input || !where.scopes) return <WhereLoading error={where.error} />;
  return <LiveProjects automation={automation} everywhereMode={everywhereMode} where={where} />;
}

const NEW_PROJECT_WORD = { on: "on", preview: "in Preview", off: "off" } as const;

/** The table over an automation's stored switches. */
function LiveProjects({
  automation,
  everywhereMode,
  where,
  flush = false,
}: {
  automation: AutopilotAutomation;
  everywhereMode: "on" | "preview";
  where: ReturnType<typeof useWhere>;
  flush?: boolean;
}) {
  const { input, scopes, apply } = where;
  if (!input || !scopes) return null;
  const save = (writes: Parameters<typeof apply.mutate>[0]) => {
    if (writes.length > 0) apply.mutate(writes);
  };
  const board = boardState(input.board);
  const projects = scopes.projects.filter((p) => !(automation.needsRepo && p.id === scopes.generalId));
  const shownIds = projects.map((p) => p.id);
  const stateOf = (id: string) => {
    const project = input.projects.find((p) => p.id === id);
    return project ? projectState(input.board, project) : "off";
  };
  const column: ProjectTableColumn = {
    key: "on",
    label: "On",
    boardOn: board !== "off",
    isOn: (id) => stateOf(id) !== "off",
    onToggle: (id, on) => save(whereProject(input, id, on)),
    onHeader: (on) => save(on ? whereOnEverywhere(input, everywhereMode) : whereOffEverywhere(input)),
    headerLoss: (on) => headerLoss(input, shownIds, on),
  };
  return (
    <ProjectTable
      label={`Where ${automation.title} runs`}
      title={automation.title}
      projects={projects}
      columns={[column]}
      differs={(id) => stateOf(id) !== board}
      boardPreview={board === "preview"}
      preview={{
        isPreview: (id) => stateOf(id) === "preview",
        isRunning: (id) => stateOf(id) !== "off",
        onChange: (id, preview) => save(whereProjectPreview(input, id, preview)),
      }}
      newProjects={`New projects: ${NEW_PROJECT_WORD[board]}.`}
      disabled={apply.isPending}
      blocked={automation.blocked}
      flush={flush}
    />
  );
}

/**
 * The builder's and import's Where for a new automation: the same table, kept in the form and written as switches
 * when it is saved. Nothing is saved yet, so its rows don't expand: Preview comes with the saved automation.
 */
export function DraftProjects({
  projects,
  everywhere,
  projectIds,
  onChange,
}: {
  projects: ReadonlyArray<{ id: string; title: string }>;
  everywhere: boolean;
  projectIds: readonly string[];
  onChange: (next: DraftWhere) => void;
}) {
  const draft: DraftWhere = { everywhere, projectIds: [...projectIds] };
  const allIds = projects.map((p) => p.id);
  const picked = projects.filter((p) => !everywhere && projectIds.includes(p.id)).map((p) => p.title);
  const column: ProjectTableColumn = {
    key: "on",
    label: "On",
    boardOn: everywhere,
    isOn: (id) => draftRowOn(draft, id),
    onToggle: (id, on) => onChange(draftRowToggle(draft, allIds, id, on)),
    onHeader: (on) => onChange(draftHeader(on)),
    // Only a switch-off can drop anything: a header that is all off has no picks left to lose.
    headerLoss: (on) => (!on && picked.length > 0 ? { projects: picked, epics: 0 } : null),
  };
  return (
    <ProjectTable
      label="Where it runs"
      title="this automation"
      projects={projects}
      columns={[column]}
      differs={(id) => !everywhere && projectIds.includes(id)}
      newProjects={`New projects: ${everywhere ? "on" : "off"}.`}
      disabled={false}
      blocked={null}
    />
  );
}
