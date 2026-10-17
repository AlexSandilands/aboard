import type { Project } from "@repo/contracts";
import { useMemo } from "react";
import { PauseAllButton } from "~/components/autopilot/PauseAllButton";
import { DigestButton } from "~/components/digest/DigestButton";
import { LabelChip, useLabelColors } from "~/components/labels/LabelChip";
import { labelCounts, toggleLabel } from "~/components/labels/labels.logic";
import { GroupIcon, ListFilterIcon, SearchIcon, XIcon } from "lucide-react";
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
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { SidebarTrigger, useSidebar } from "~/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useBoard } from "~/state/queries";
import { useBoardView, usePalette } from "~/state/ui";
import {
  useEpicFilter,
  useLabelFilter,
  useSelectedTaskId,
  useSetEpicFilter,
  useSetLabelFilter,
  useSetProjectFilter,
} from "./boardNavigation";
import { cn } from "~/lib/utils";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The board's top bar (52px; 40px under the desktop title bar): title or scoped project, filters, and the palette hint. */
export function BoardHeader({ scopedProject }: { scopedProject: Project | null }) {
  const { isMobile, open } = useSidebar();
  const attentionOnly = useBoardView((s) => s.attentionOnly);
  const setAttentionOnly = useBoardView((s) => s.setAttentionOnly);
  const hasPrOnly = useBoardView((s) => s.hasPrOnly);
  const setHasPrOnly = useBoardView((s) => s.setHasPrOnly);
  const showArchived = useBoardView((s) => s.showArchived);
  const setShowArchived = useBoardView((s) => s.setShowArchived);
  const selectedLabels = useLabelFilter();
  const setLabelFilter = useSetLabelFilter();
  const filtered = attentionOnly || hasPrOnly || showArchived || selectedLabels.length > 0;
  const setProjectFilter = useSetProjectFilter();
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
      <ActiveEpicFilter />
      <ActiveLabelFilters selected={selectedLabels} onChange={(labels) => void setLabelFilter(labels)} />
      <div className="ms-auto flex items-center gap-1.5">
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
              <MenuCheckboxItem checked={attentionOnly} onCheckedChange={setAttentionOnly}>
                Needs attention only
              </MenuCheckboxItem>
              <MenuCheckboxItem checked={hasPrOnly} onCheckedChange={setHasPrOnly}>
                Has PR
              </MenuCheckboxItem>
              <MenuCheckboxItem checked={showArchived} onCheckedChange={setShowArchived}>
                Show archived
              </MenuCheckboxItem>
            </MenuGroup>
            <LabelFilterGroup
              scopedProjectId={scopedProject?.id ?? null}
              selected={selectedLabels}
              onChange={(labels) => void setLabelFilter(labels)}
            />
          </MenuPopup>
        </Menu>
        <Button variant="outline" size="xs" onClick={() => usePalette.getState().openPalette()}>
          <SearchIcon />
          <span className="text-muted-foreground">Search</span>
          <KbdGroup>
            <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
        </Button>
      </div>
    </header>
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
