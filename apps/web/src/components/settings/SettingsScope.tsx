// Adapted from T3 Code (apps/web/src/components/settings/SettingsScopeSentence.tsx, SettingsScopeContext.tsx), MIT —
// see NOTICE. Only the project axis: the board has no environments.
import type { Project } from "@repo/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, LayersIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
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
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { useBoard } from "~/state/queries";
import { useOpenSettings } from "./settingsNavigation";
import { filterScopeOptions, scopeProject, scopeProjects, usesScopeSearch } from "./settingsScope.logic";

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

/** "Settings for [All projects ▾]": the scope sentence at the top of the Projects page, which picks the project shown. */
export function SettingsScopeSentence() {
  const { project, projects, setScope } = useSettingsScope();
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-3 text-sm text-muted-foreground sm:px-4">
      <span className="shrink-0">Settings for</span>
      <ProjectPicker project={project} projects={projects} onChange={setScope} />
    </p>
  );
}

/**
 * "Overridden in N projects" on a board-wide row some projects set for themselves: a link to that project's
 * overrides on the Projects page, or with several a menu of them.
 */
export function OverriddenInProjects({ projects, target }: { projects: ReadonlyArray<Project>; target: string }) {
  const openSettings = useOpenSettings();
  const open = (project: Project) => openSettings(target, { project: project.id });
  const label = `Overridden in ${projects.length === 1 ? "1 project" : `${projects.length} projects`}`;
  const className =
    "inline-flex items-center gap-1 rounded-sm text-xs text-info-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring";
  if (projects.length === 1) {
    const only = projects[0]!;
    return (
      <button type="button" className={className} onClick={() => open(only)}>
        {label}: {only.title}
      </button>
    );
  }
  return (
    <Menu>
      <MenuTrigger className={className}>
        {label}
        <ChevronDownIcon aria-hidden className="size-3" />
      </MenuTrigger>
      <MenuPopup align="start">
        {projects.map((p) => (
          <MenuItem key={p.id} onClick={() => open(p)}>
            <ProjectFavicon title={p.title} icon={p.icon} className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{p.title}</span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
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

/**
 * The project picker: a menu up to six projects, a searchable combobox past that. Its first choice, null, is All
 * projects unless `allLabel` names it otherwise (the board's own values, say).
 */
export function ProjectPicker({
  project,
  projects,
  onChange,
  allLabel = "All projects",
  ariaLabel = "Project",
}: {
  project: Project | null;
  projects: ReadonlyArray<Project>;
  onChange: (projectId: string | null) => void;
  allLabel?: string;
  ariaLabel?: string;
}) {
  const [query, setQuery] = useState("");
  const searchable = usesScopeSearch(projects.length);
  const value = project?.id ?? ALL;
  const label = project?.title ?? allLabel;
  const choices: ScopeOption[] = [
    { value: ALL, label: allLabel, project: null },
    ...projects.map((p) => ({ value: p.id, label: p.title, project: p })),
  ];
  const pick = (next: string) => onChange(next === ALL ? null : next);
  const Trigger = searchable ? ComboboxTrigger : MenuTrigger;
  const trigger = (
    <Trigger
      aria-label={`${ariaLabel}: ${label}`}
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
