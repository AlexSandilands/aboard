// Layout adapted from T3 Code (SidebarThreadHeader.tsx and the project scope combobox in Sidebar.tsx), MIT — see NOTICE.
import type { Project } from "@repo/contracts";
import {
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
import { usePalette } from "~/state/ui";
import { useOpenSettings } from "~/components/settings/settingsNavigation";
import {
  useBoardFilters,
  useProjectFilter,
  useSetBoardFilters,
  useSetProjectFilter,
} from "~/components/board/boardNavigation";
import { SidebarHeaderIconButton } from "./SidebarHeaderIconButton";

/** Search field plus the segmented project-filter / add-project / new-task buttons. */
export function SidebarSearchHeader({ projects }: { projects: ReadonlyArray<Project> }) {
  const [search, setSearch] = useSearchText();
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
          aria-label="Search tasks by title, #number, Jira key or label"
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
            <ProjectScopeCombobox projects={projects} selectedId={projectFilter} anchorRef={searchFieldRef} />
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
          tooltip="New task (N)"
          onClick={() => usePalette.getState().openPalette({ kind: "new-task", projectId: projectFilter ?? undefined })}
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

/** T3's "Filter threads by project" combobox: scopes the board through `?project=`. */
function ProjectScopeCombobox({
  projects,
  selectedId,
  anchorRef,
}: {
  projects: ReadonlyArray<Project>;
  selectedId: string | null;
  anchorRef: RefObject<HTMLDivElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const setProjectFilter = useSetProjectFilter();
  const openSettings = useOpenSettings();
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const items = useMemo<ScopeItem[]>(
    () => [ALL_PROJECTS, ...projects.map((p) => ({ value: p.id, label: p.title }))],
    [projects],
  );
  const selectedProject = selectedId ? (projectById.get(selectedId) ?? null) : null;
  const selectedItem = items.find((item) => item.value === selectedProject?.id) ?? ALL_PROJECTS;

  return (
    <Combobox
      items={items}
      autoHighlight
      itemToStringLabel={(item: ScopeItem) => item.label}
      isItemEqualToValue={(a: ScopeItem, b: ScopeItem) => a.value === b.value}
      open={open}
      onOpenChange={setOpen}
      value={selectedItem}
      onValueChange={(item: ScopeItem | null) => {
        if (!item) return;
        void setProjectFilter(item.value === ALL_PROJECTS.value ? null : item.value);
      }}
    >
      <ComboboxTrigger
        render={
          <SidebarHeaderIconButton
            label={selectedProject ? `Filter board by project: ${selectedProject.title}` : "Filter board by project"}
          />
        }
      >
        {selectedProject ? (
          // Wrapped so the button's direct-child svg colour rule cannot override the project's own colour.
          <span className="flex shrink-0">
            <ProjectFavicon title={selectedProject.title} icon={selectedProject.icon} className="size-4" />
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
                {project ? (
                  <ProjectFavicon title={project.title} icon={project.icon} className="size-4 shrink-0" />
                ) : (
                  <FolderIcon className="size-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
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
