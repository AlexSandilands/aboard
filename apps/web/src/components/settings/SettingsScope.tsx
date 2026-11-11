// Adapted from T3 Code (apps/web/src/components/settings/SettingsScopeSentence.tsx, SettingsScopeContext.tsx), MIT —
// see NOTICE. Only the project axis: the board has no environments.
import type { Project } from "@repo/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, LayersIcon } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { ProjectFavicon } from "~/components/project/ProjectFavicon";
import { Button } from "~/components/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "~/components/ui/combobox";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useBoard } from "~/state/queries";
import {
  BOARD_WIDE_HINT,
  filterScopeOptions,
  rowIsInert,
  type RowScope,
  scopeProject,
  scopeProjects,
  usesScopeSearch,
} from "./settingsScope.logic";

/** The `?project=` the settings URL carries, as asked for (it may name a project that is gone). */
export function useScopeParam(): string | undefined {
  return useSearch({ strict: false, select: (search) => search.project });
}

/**
 * The settings scope: the project chosen in `?project=`, or null for All projects (also when the id is gone), the
 * projects the menu offers, and a way to switch that keeps the page and its other params.
 */
export function useSettingsScope(): {
  project: Project | null;
  projects: Project[];
  setScope: (projectId: string | null) => void;
} {
  const requested = useScopeParam();
  const board = useBoard();
  const navigate = useNavigate();
  const projects = useMemo(() => scopeProjects(board.data?.projects), [board.data?.projects]);
  const project = scopeProject(projects, requested);
  const setScope = useCallback(
    (projectId: string | null) =>
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, project: projectId ?? undefined }),
        hash: (prev) => prev ?? "",
        hashScrollIntoView: false,
        replace: true,
      }),
    [navigate],
  );
  return { project, projects, setScope };
}

interface ScopeState {
  /** The project being edited, or null for All projects (and on pages that show no sentence). */
  project: Project | null;
  /** Whether board-wide rows inside are dimmed one by one. */
  dimRows: boolean;
  /** Whether a stretch around is dimmed already, so nothing inside dims twice. */
  dimmed: boolean;
}

const ScopeContext = createContext<ScopeState>({ project: null, dimRows: false, dimmed: false });

/** The scope the rows below are shown in. */
export const useRowScope = (): ScopeState => useContext(ScopeContext);

/** Puts a page in the scope chosen in its sentence. */
export function SettingsScopeProvider({ project, children }: { project: Project | null; children: ReactNode }) {
  const value = useMemo(() => ({ project, dimRows: false, dimmed: false }), [project]);
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

/**
 * A stretch of the page in the scope: `project` holds rows a project can set (each board row in it is dimmed on its
 * own), `board` is board-wide as a whole (dimmed and inert in project scope), `any` is never dimmed.
 */
export function ScopedStretch({ scope, children }: { scope: RowScope; children: ReactNode }) {
  const outer = useRowScope();
  const dimWhole = scope === "board" && outer.project !== null && !outer.dimmed;
  const value = useMemo(
    () => ({
      project: outer.project,
      dimRows: scope === "project" && !outer.dimmed,
      dimmed: outer.dimmed || dimWhole,
    }),
    [outer.project, outer.dimmed, scope, dimWhole],
  );
  return (
    <ScopeContext.Provider value={value}>
      {dimWhole ? <BoardWide className="space-y-6">{children}</BoardWide> : children}
    </ScopeContext.Provider>
  );
}

/** Whether a row with this scope is dimmed where it is shown. */
export function useRowInert(scope: RowScope): boolean {
  const { project, dimRows } = useRowScope();
  return dimRows && rowIsInert(scope, project !== null);
}

/**
 * Board-wide settings in project scope: dimmed and inert, not hidden, so the page keeps its shape when the scope
 * changes. A tooltip says why (T3's way).
 */
export function BoardWide({ children, className }: { children: ReactNode; className?: string }) {
  return (
    // A stretch can be tall, so the tooltip follows the pointer rather than sitting above the whole of it.
    <Tooltip trackCursorAxis="both">
      <TooltipTrigger
        render={<div data-board-wide="" className="cursor-not-allowed" />}
        // The trigger is a plain wrapper: nothing in it can be reached, so it isn't a tab stop either.
        tabIndex={-1}
      >
        <div inert className={cn("pointer-events-none opacity-45 grayscale select-none", className)}>
          {children}
        </div>
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-64">
        {BOARD_WIDE_HINT}
      </TooltipPopup>
    </Tooltip>
  );
}

/** "Applying settings for [All projects ▾]": the scope sentence at the top of a page with per-project settings. */
export function SettingsScopeSentence() {
  const { project, projects, setScope } = useSettingsScope();
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-3 text-sm text-muted-foreground sm:px-4">
      <span className="shrink-0">Applying settings for</span>
      <ProjectScopeMenu project={project} projects={projects} onChange={setScope} />
    </p>
  );
}

interface ScopeOption {
  /** A project id, or ALL for All projects. */
  value: string;
  label: string;
  project: Project | null;
}

const ALL = "";

function OptionIcon({ project }: { project: Project | null }) {
  return project ? (
    <ProjectFavicon title={project.title} icon={project.icon} className="size-3.5 shrink-0" />
  ) : (
    <LayersIcon aria-hidden className="size-3.5 shrink-0" />
  );
}

/** The project picker: a menu up to six projects, a searchable combobox past that. */
function ProjectScopeMenu({
  project,
  projects,
  onChange,
}: {
  project: Project | null;
  projects: ReadonlyArray<Project>;
  onChange: (projectId: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const searchable = usesScopeSearch(projects.length);
  const value = project?.id ?? ALL;
  const label = project?.title ?? "All projects";
  const choices: ScopeOption[] = [
    { value: ALL, label: "All projects", project: null },
    ...projects.map((p) => ({ value: p.id, label: p.title, project: p })),
  ];
  const pick = (next: string) => onChange(next === ALL ? null : next);
  const Trigger = searchable ? ComboboxTrigger : MenuTrigger;
  const trigger = (
    <Trigger
      aria-label={`Project scope: ${label}`}
      render={<Button variant="outline" size="sm" />}
      className="min-w-0 max-w-72"
    >
      {project ? <OptionIcon project={project} /> : null}
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDownIcon
        aria-hidden
        strokeWidth={1.75}
        className="-me-0.5 size-3.5 shrink-0 text-muted-foreground opacity-70"
      />
    </Trigger>
  );
  if (searchable) {
    return (
      <Combobox
        items={choices}
        filteredItems={filterScopeOptions(choices, query)}
        filter={null}
        autoHighlight
        itemToStringLabel={(option: ScopeOption) => option.label}
        isItemEqualToValue={(a: ScopeOption, b: ScopeOption) => a.value === b.value}
        value={choices.find((option) => option.value === value) ?? null}
        onOpenChange={(open) => {
          if (!open) setQuery("");
        }}
        onValueChange={(option: ScopeOption | null) => {
          if (option) pick(option.value);
        }}
      >
        {trigger}
        <ComboboxPopup align="start" className="w-[min(20rem,var(--available-width))]">
          <ComboboxSearchInput
            aria-label="Search projects"
            placeholder="Search projects"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ComboboxEmpty>No matching projects.</ComboboxEmpty>
          <ComboboxList>
            {(option: ScopeOption) => (
              <ComboboxItem key={option.value} value={option} hideIndicator>
                <OptionIcon project={option.project} />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.value === value ? <CheckIcon aria-hidden className="size-3.5 shrink-0" /> : null}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    );
  }
  return (
    <Menu>
      {trigger}
      <MenuPopup align="start">
        <div className="w-72 max-w-full">
          <MenuRadioGroup
            value={value}
            onValueChange={(next) => {
              if (typeof next === "string") pick(next);
            }}
          >
            {choices.map((option, index) => (
              <div key={option.value || "all"}>
                <MenuRadioItem value={option.value} closeOnClick>
                  <span className="flex min-w-0 items-center gap-2">
                    <OptionIcon project={option.project} />
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    <MenuRadioItemIndicator />
                  </span>
                </MenuRadioItem>
                {index === 0 && choices.length > 1 ? <MenuSeparator /> : null}
              </div>
            ))}
          </MenuRadioGroup>
        </div>
      </MenuPopup>
    </Menu>
  );
}
