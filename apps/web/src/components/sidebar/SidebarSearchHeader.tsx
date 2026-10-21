// Layout adapted from T3 Code (SidebarThreadHeader.tsx and the project scope combobox in Sidebar.tsx), MIT — see NOTICE.
import type { Project } from "@repo/contracts";
import {
  CheckIcon,
  FolderIcon,
  FolderPlusIcon,
  ListFilterIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
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
import { SidebarInput } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";
import { usePalette } from "~/state/ui";
import { useShortcutLabel } from "~/components/layout/useKeybindings";
import { useOpenSettings } from "~/components/settings/settingsNavigation";
import {
  useBoardFilters,
  useProjectFilter,
  useSetBoardFilters,
  useSetProjectScope,
} from "~/components/board/boardNavigation";
import { SidebarHeaderIconButton } from "./SidebarHeaderIconButton";

/** Search field plus the segmented project-filter / add-project / new-task buttons. */
export function SidebarSearchHeader({ projects }: { projects: ReadonlyArray<Project> }) {
  const [search, setSearch] = useSearchText();
  const newTaskShortcut = useShortcutLabel("idea.new");
  const searchFieldRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const projectFilter = useProjectFilter();

  return (
    <div className="flex items-center gap-1">
      <div
        ref={searchFieldRef}
        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
      >
        <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
        <SidebarInput
          ref={searchInputRef}
          nativeInput
          type="search"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && search) {
              event.preventDefault();
              setSearch("");
            }
          }}
          placeholder="Search"
          aria-label="Search tasks by title, #number, ticket key or label"
          className="min-w-0 flex-1"
        />
        {search ? (
          <Button
            type="button"
            size="icon-micro"
            variant="ghost-muted"
            className="shrink-0"
            aria-label="Clear search"
            onClick={() => {
              setSearch("");
              searchInputRef.current?.focus();
            }}
          >
            <XIcon className="size-3" />
          </Button>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center">
        {projects.length > 0 ? (
          <>
            <ProjectScopeCombobox projects={projects} selectedIds={projectFilter} anchorRef={searchFieldRef} />
            <SidebarHeaderIconButton
              label="Add project"
              onClick={() => usePalette.getState().openPalette({ kind: "add-project" })}
            >
              <FolderPlusIcon />
            </SidebarHeaderIconButton>
          </>
        ) : null}
        <SidebarHeaderIconButton
          label="New task"
          tooltip={newTaskShortcut ? `New task (${newTaskShortcut})` : "New task"}
          onClick={() =>
            usePalette
              .getState()
              .openPalette({ kind: "new-task", projectId: projectFilter.length === 1 ? projectFilter[0] : undefined })
          }
        >
          <SquarePenIcon />
        </SidebarHeaderIconButton>
      </div>
    </div>
  );
}

/**
 * The board's `?q=` as a text field's value. The field keeps its own text so typing never waits for the URL, and
 * takes the URL's only when it changes for some other reason (a saved view, a reset, Back).
 */
function useSearchText(): [string, (value: string) => void] {
  const text = useBoardFilters().text;
  const setFilters = useSetBoardFilters();
  const [draft, setDraft] = useState(text);
  // What this field has put in the URL and the URL hasn't shown yet, oldest first.
  const sent = useRef<string[]>([]);
  useEffect(() => {
    const at = sent.current.indexOf(text);
    if (at >= 0) {
      sent.current = sent.current.slice(at + 1);
      return;
    }
    sent.current = [];
    setDraft(text);
  }, [text]);
  return [
    draft,
    (value) => {
      setDraft(value);
      sent.current.push(value.trim());
      void setFilters({ text: value.trim() }, { replace: true });
    },
  ];
}

interface ScopeItem {
  value: string;
  label: string;
}

const ALL_PROJECTS: ScopeItem = { value: "all", label: "All projects" };

/**
 * A multi-select over the projects, scoping the board through `?project=`. Nothing ticked is the whole board, which
 * the "All projects" row stands for.
 */
function ProjectScopeCombobox({
  projects,
  selectedIds,
  anchorRef,
}: {
  projects: ReadonlyArray<Project>;
  selectedIds: ReadonlyArray<string>;
  anchorRef: RefObject<HTMLDivElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const setProjectScope = useSetProjectScope();
  const openSettings = useOpenSettings();
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const items = useMemo<ScopeItem[]>(
    () => [ALL_PROJECTS, ...projects.map((p) => ({ value: p.id, label: p.title }))],
    [projects],
  );
  const selectedProjects = useMemo(() => projects.filter((p) => selectedIds.includes(p.id)), [projects, selectedIds]);
  // "All projects" counts as the selected row while no project is.
  const value = useMemo(
    () => (selectedProjects.length ? items.filter((item) => selectedIds.includes(item.value)) : [ALL_PROJECTS]),
    [items, selectedIds, selectedProjects.length],
  );
  const label =
    selectedProjects.length === 0
      ? "Filter board by project"
      : `Filter board by projects: ${selectedProjects.map((p) => p.title).join(", ")}`;

  return (
    <Combobox
      multiple
      items={items}
      autoHighlight
      itemToStringLabel={(item: ScopeItem) => item.label}
      isItemEqualToValue={(a: ScopeItem, b: ScopeItem) => a.value === b.value}
      open={open}
      onOpenChange={setOpen}
      value={value}
      onValueChange={(next: ScopeItem[]) => {
        const pickedAll = next.some((item) => item.value === ALL_PROJECTS.value);
        const wasAll = value.some((item) => item.value === ALL_PROJECTS.value);
        void setProjectScope(
          pickedAll && !wasAll ? [] : next.filter((i) => i.value !== ALL_PROJECTS.value).map((i) => i.value),
        );
      }}
    >
      <ComboboxTrigger render={<SidebarHeaderIconButton label={label} />}>
        {selectedProjects.length > 0 ? (
          // Wrapped so the button's direct-child svg colour rule cannot override the project's own colour.
          <span className="flex shrink-0 -space-x-1.5">
            {selectedProjects.slice(0, 3).map((project) => (
              <ProjectFavicon key={project.id} title={project.title} icon={project.icon} className="size-4" />
            ))}
          </span>
        ) : (
          <ListFilterIcon className="size-4" />
        )}
      </ComboboxTrigger>
      <ComboboxPopup
        align="start"
        anchor={anchorRef}
        className="max-w-[min(18rem,var(--available-width))] overflow-hidden"
      >
        <ComboboxSearchInput aria-label="Search projects" placeholder="Search projects..." />
        <ComboboxEmpty>No matching projects.</ComboboxEmpty>
        <ComboboxList>
          {(item: ScopeItem) => {
            const project = projectById.get(item.value) ?? null;
            const ticked = value.some((v) => v.value === item.value);
            return (
              <ComboboxItem
                key={item.value}
                hideIndicator
                value={item}
                onContextMenu={(event) => {
                  if (!project) return;
                  event.preventDefault();
                  setOpen(false);
                  openSettings("project", { project: project.id });
                }}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "me-2 flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input",
                    ticked && "border-primary bg-primary text-primary-foreground",
                  )}
                >
                  {ticked ? <CheckIcon className="size-3" /> : null}
                </span>
                {project ? (
                  <ProjectFavicon title={project.title} icon={project.icon} className="size-4 shrink-0" />
                ) : (
                  <FolderIcon className="size-4 shrink-0" />
                )}
                <span className="ms-2 min-w-0 flex-1 truncate text-sm">{item.label}</span>
                {project ? (
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    tabIndex={-1}
                    aria-hidden="true"
                    title={`Project settings for ${project.title}`}
                    className="ml-auto"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpen(false);
                      openSettings("project", { project: project.id });
                    }}
                  >
                    <SettingsIcon className="size-3.5" />
                  </Button>
                ) : null}
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
