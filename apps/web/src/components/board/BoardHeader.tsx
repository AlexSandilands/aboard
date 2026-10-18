import { TASK_STATUSES, type Project } from "@repo/contracts";
import { useMemo } from "react";
import { PauseAllButton } from "~/components/autopilot/PauseAllButton";
import { DigestButton } from "~/components/digest/DigestButton";
import { useNewGeneralTask } from "~/components/command/useNewGeneralTask";
import { useShortcutLabel } from "~/components/layout/useKeybindings";
import { LabelChip, useLabelColors } from "~/components/labels/LabelChip";
import { labelCounts, toggleLabel } from "~/components/labels/labels.logic";
import { BookmarkIcon, GroupIcon, InboxIcon, ListFilterIcon, SearchIcon, XIcon } from "lucide-react";
import { NotificationsBell } from "~/components/notifications/NotificationsBell";
import { ProjectFavicon } from "~/components/project/ProjectFavicon";
import { Button } from "~/components/ui/button";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { SidebarTrigger, useSidebar } from "~/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useBoard } from "~/state/queries";
import { useDialogs, usePalette } from "~/state/ui";
import { useSavedViews } from "~/state/views";
import { activeView, canAddView } from "~/components/views/views.logic";
import {
  useApplyFilterParams,
  useBoardFilterParams,
  useBoardFilters,
  useEpicFilter,
  useLabelFilter,
  useResetFilters,
  useSelectedTaskId,
  useSetBoardFilters,
  useSetEpicFilter,
  useSetLabelFilter,
  useSetProjectFilter,
} from "./boardNavigation";
import {
  activeFilterCount,
  AUTOPILOT_CHOICES,
  isEmptyView,
  TIER_CHOICES,
  toggleChoice,
  type AutopilotChoice,
  type TierChoice,
} from "./boardFilters.logic";
import { cn } from "~/lib/utils";

/** The board's top bar (52px; 40px under the desktop title bar): title or scoped project, filters, and the palette hint. */
export function BoardHeader({ scopedProject }: { scopedProject: Project | null }) {
  const { isMobile, open } = useSidebar();
  const filters = useBoardFilters();
  const setFilters = useSetBoardFilters();
  const paletteShortcut = useShortcutLabel("palette.open");
  const selectedLabels = useLabelFilter();
  const setLabelFilter = useSetLabelFilter();
  const filtered = activeFilterCount(filters) > 0;
  const setProjectFilter = useSetProjectFilter();
  const newGeneralTask = useNewGeneralTask();
  // With the task panel closed this header reaches the window's right edge and the native controls.
  const atRightEdge = useSelectedTaskId() === null;

  return (
    <header
      className={cn(
        "drag-region flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 ps-(--workspace-gutter-start) pe-(--workspace-gutter-end)",
        atRightEdge && "wco:pe-(--workspace-native-controls-inset)",
      )}
    >
      {isMobile || !open ? <SidebarTrigger variant="ghost-muted" size="icon-sm" aria-label="Toggle sidebar" /> : null}
      {scopedProject ? (
        <div className="flex min-w-0 items-center gap-2">
          <ProjectFavicon title={scopedProject.title} icon={scopedProject.icon} className="size-4" />
          <h1 className="truncate text-sm font-medium">{scopedProject.title}</h1>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-micro"
                  aria-label="Show all projects"
                  onClick={() => void setProjectFilter(null)}
                />
              }
            >
              <XIcon />
            </TooltipTrigger>
            <TooltipPopup>Show all projects</TooltipPopup>
          </Tooltip>
        </div>
      ) : (
        <h1 className="text-sm font-medium">Board</h1>
      )}
      <FiltersActive />
      <ActiveEpicFilter />
      <ActiveLabelFilters selected={selectedLabels} onChange={(labels) => void setLabelFilter(labels)} />
      <div className="ms-auto flex items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-sm"
                aria-label="New general task"
                disabled={newGeneralTask.pending}
                onClick={newGeneralTask.start}
              />
            }
          >
            <InboxIcon />
          </TooltipTrigger>
          <TooltipPopup>New general task</TooltipPopup>
        </Tooltip>
        <PauseAllButton />
        <DigestButton />
        <NotificationsBell />
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button variant={filtered ? "secondary" : "ghost-muted"} size="icon-sm" aria-label="Filter board" />
                  }
                />
              }
            >
              <ListFilterIcon />
            </TooltipTrigger>
            <TooltipPopup>Filter</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            <MenuGroup>
              <MenuGroupLabel>Show</MenuGroupLabel>
              <MenuCheckboxItem
                checked={filters.inProgress}
                onCheckedChange={(inProgress) => void setFilters({ inProgress })}
              >
                In progress, all projects
              </MenuCheckboxItem>
              <MenuCheckboxItem
                checked={filters.attention}
                onCheckedChange={(attention) => void setFilters({ attention })}
              >
                Needs attention only
              </MenuCheckboxItem>
              <MenuCheckboxItem checked={filters.hasPr} onCheckedChange={(hasPr) => void setFilters({ hasPr })}>
                Has PR
              </MenuCheckboxItem>
              <MenuCheckboxItem checked={filters.blocked} onCheckedChange={(blocked) => void setFilters({ blocked })}>
                Blocked
              </MenuCheckboxItem>
              <MenuCheckboxItem
                checked={filters.priority}
                onCheckedChange={(priority) => void setFilters({ priority })}
              >
                Priority
              </MenuCheckboxItem>
              <MenuCheckboxItem
                checked={filters.archived}
                onCheckedChange={(archived) => void setFilters({ archived })}
              >
                Show archived
              </MenuCheckboxItem>
            </MenuGroup>
            <MenuSeparator />
            <StatusFilterMenu />
            <TierFilterMenu />
            <AutopilotFilterMenu />
            <EpicFilterMenu />
            <LabelFilterGroup
              scopedProjectId={scopedProject?.id ?? null}
              selected={selectedLabels}
              onChange={(labels) => void setLabelFilter(labels)}
            />
            <ViewsMenuGroup />
          </MenuPopup>
        </Menu>
        <Button variant="outline" size="xs" onClick={() => usePalette.getState().openPalette()}>
          <SearchIcon />
          <span className="text-muted-foreground">Search</span>
          {paletteShortcut ? (
            <KbdGroup>
              <Kbd>{paletteShortcut}</Kbd>
            </KbdGroup>
          ) : null}
        </Button>
      </div>
    </header>
  );
}

/** A submenu of checkboxes for one list filter (status, tier, Autopilot flag), with how many are chosen. */
function ChoiceFilterMenu<T extends string>({
  title,
  choices,
  chosen,
  onChange,
}: {
  title: string;
  choices: ReadonlyArray<{ value: T; label: string }>;
  chosen: ReadonlyArray<T>;
  onChange: (chosen: T[]) => void;
}) {
  const values = choices.map((choice) => choice.value);
  return (
    <MenuSub>
      <MenuSubTrigger>
        {title}
        {chosen.length ? (
          <span className="ms-auto pe-1 text-xs tabular-nums text-muted-foreground">{chosen.length}</span>
        ) : null}
      </MenuSubTrigger>
      <MenuSubPopup>
        <MenuGroup>
          {choices.map(({ value, label }) => (
            <MenuCheckboxItem
              key={value}
              checked={chosen.includes(value)}
              closeOnClick={false}
              onCheckedChange={() => onChange(toggleChoice(chosen, value, values))}
            >
              {label}
            </MenuCheckboxItem>
          ))}
          {chosen.length ? <MenuItem onClick={() => onChange([])}>Clear {title.toLowerCase()}</MenuItem> : null}
        </MenuGroup>
      </MenuSubPopup>
    </MenuSub>
  );
}

function StatusFilterMenu() {
  const { statuses } = useBoardFilters();
  const setFilters = useSetBoardFilters();
  return (
    <ChoiceFilterMenu
      title="Status"
      choices={TASK_STATUSES}
      chosen={statuses}
      onChange={(next) => void setFilters({ statuses: next })}
    />
  );
}

function TierFilterMenu() {
  const { tiers } = useBoardFilters();
  const setFilters = useSetBoardFilters();
  return (
    <ChoiceFilterMenu<TierChoice>
      title="Model tier"
      choices={TIER_CHOICES}
      chosen={tiers}
      onChange={(next) => void setFilters({ tiers: next })}
    />
  );
}

function AutopilotFilterMenu() {
  const { autopilot } = useBoardFilters();
  const setFilters = useSetBoardFilters();
  return (
    <ChoiceFilterMenu<AutopilotChoice>
      title="Autopilot flag"
      choices={AUTOPILOT_CHOICES}
      chosen={autopilot}
      onChange={(next) => void setFilters({ autopilot: next })}
    />
  );
}

/** Which epic's band to show: one at a time, as `?epic=` always was. */
function EpicFilterMenu() {
  const tasks = useBoard().data?.tasks;
  const epicId = useEpicFilter();
  const setEpicFilter = useSetEpicFilter();
  const epics = useMemo(() => (tasks ?? []).filter((t) => t.kind === "epic"), [tasks]);
  if (epics.length === 0) return null;
  return (
    <MenuSub>
      <MenuSubTrigger>Epic</MenuSubTrigger>
      <MenuSubPopup>
        <MenuRadioGroup value={epicId ?? ""} onValueChange={(value) => void setEpicFilter(value || null)}>
          <MenuRadioItem value="">Any epic</MenuRadioItem>
          {epics.map((epic) => (
            <MenuRadioItem key={epic.id} value={epic.id}>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 tabular-nums text-muted-foreground">#{epic.number}</span>
                <span className="max-w-64 min-w-0 truncate">{epic.title}</span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSubPopup>
    </MenuSub>
  );
}

/** Switch to a saved view, save the current filters as one, or reset them. */
function ViewsMenuGroup() {
  const views = useSavedViews();
  const params = useBoardFilterParams();
  const filters = useBoardFilters();
  const apply = useApplyFilterParams();
  const reset = useResetFilters();
  const active = activeView(views, params);
  return (
    <>
      <MenuSeparator />
      {views.length > 0 ? (
        <MenuSub>
          <MenuSubTrigger>Views</MenuSubTrigger>
          <MenuSubPopup>
            <MenuRadioGroup
              value={active?.id ?? ""}
              onValueChange={(id) => {
                const view = views.find((v) => v.id === id);
                if (view) void apply(view.filters);
              }}
            >
              {views.map((view) => (
                <MenuRadioItem key={view.id} value={view.id}>
                  {view.name}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
      ) : null}
      <MenuItem
        disabled={isEmptyView(params) || !canAddView(views)}
        onClick={() => useDialogs.getState().openViewDialog({ kind: "save" })}
      >
        Save view…
      </MenuItem>
      {activeFilterCount(filters) > 0 ? <MenuItem onClick={() => void reset()}>Reset filters</MenuItem> : null}
    </>
  );
}

/** "Filters active": how many filters are on (or the saved view they match), with a one-click reset. */
function FiltersActive() {
  const filters = useBoardFilters();
  const params = useBoardFilterParams();
  const views = useSavedViews();
  const reset = useResetFilters();
  const count = activeFilterCount(filters);
  if (count === 0) return null;
  const view = activeView(views, params);
  return (
    <span
      role="status"
      className="inline-flex h-6 max-w-64 min-w-0 shrink-0 items-center gap-1.5 rounded-md border border-primary/30 bg-primary/8 ps-1.5 pe-0.5 text-xs text-foreground/80"
    >
      {view ? (
        <BookmarkIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
      ) : (
        <ListFilterIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
      )}
      <span className="min-w-0 truncate">
        {view ? view.name : `${count} ${count === 1 ? "filter" : "filters"} active`}
      </span>
      <Button variant="ghost-muted" size="icon-micro" aria-label="Reset filters" onClick={() => void reset()}>
        <XIcon />
      </Button>
    </span>
  );
}

/** The filter menu's label checkboxes, with how many cards in scope carry each. Selected labels stay listed. */
function LabelFilterGroup({
  scopedProjectId,
  selected,
  onChange,
}: {
  scopedProjectId: string | null;
  selected: ReadonlyArray<string>;
  onChange: (labels: string[]) => void;
}) {
  const tasks = useBoard().data?.tasks;
  const colors = useLabelColors();
  const counts = useMemo(() => {
    const inScope = (tasks ?? []).filter((task) => !scopedProjectId || task.projectId === scopedProjectId);
    const list = labelCounts(inScope);
    for (const label of selected) if (!list.some((l) => l.name === label)) list.push({ name: label, count: 0 });
    return list;
  }, [tasks, scopedProjectId, selected]);
  if (counts.length === 0) return null;
  return (
    <>
      <MenuSeparator />
      <MenuGroup>
        <MenuGroupLabel>Labels (any)</MenuGroupLabel>
        {counts.map(({ name, count }) => (
          <MenuCheckboxItem
            key={name}
            checked={selected.includes(name)}
            closeOnClick={false}
            onCheckedChange={() => onChange(toggleLabel(selected, name))}
          >
            <span className="flex w-full min-w-0 items-center gap-2">
              <LabelChip label={name} colors={colors} />
              <span className="ms-auto text-xs tabular-nums text-muted-foreground">{count}</span>
            </span>
          </MenuCheckboxItem>
        ))}
        {selected.length ? <MenuItem onClick={() => onChange([])}>Clear labels</MenuItem> : null}
      </MenuGroup>
    </>
  );
}

/** The `?epic=` filter as a removable chip; nothing when it names no epic on the board. */
function ActiveEpicFilter() {
  const epicId = useEpicFilter();
  const setEpicFilter = useSetEpicFilter();
  const epic = useBoard().data?.tasks.find((t) => t.id === epicId && t.kind === "epic");
  if (!epic) return null;
  return (
    <span className="inline-flex h-6 max-w-64 min-w-0 shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-card/40 ps-1.5 pe-0.5 text-xs text-foreground/80">
      <GroupIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 tabular-nums text-muted-foreground">#{epic.number}</span>
      <span className="min-w-0 truncate">{epic.title}</span>
      <Button
        variant="ghost-muted"
        size="icon-micro"
        aria-label={`Stop filtering to epic #${epic.number}`}
        onClick={() => void setEpicFilter(null)}
      >
        <XIcon />
      </Button>
    </span>
  );
}

/** Selected label filters as removable chips beside the title. */
function ActiveLabelFilters({
  selected,
  onChange,
}: {
  selected: ReadonlyArray<string>;
  onChange: (labels: string[]) => void;
}) {
  const colors = useLabelColors();
  if (selected.length === 0) return null;
  return (
    <div className="flex min-w-0 items-center gap-1 overflow-hidden" aria-label="Label filters">
      {selected.map((label) => (
        <LabelChip
          key={label}
          label={label}
          colors={colors}
          size="default"
          onRemove={() => onChange(selected.filter((l) => l !== label))}
        />
      ))}
    </div>
  );
}
