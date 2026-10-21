// Sortable project list adapted from T3 Code's LegacySidebar.tsx (MIT) — see NOTICE.
import {
  closestCorners,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { BoardSnapshot, Project } from "@repo/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { FolderPlusIcon, SettingsIcon } from "lucide-react";
import { memo, useMemo, useRef, useState } from "react";
import { ProjectFavicon } from "~/components/project/ProjectFavicon";
import { Button } from "~/components/ui/button";
import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, useSidebar } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";
import { useReorderProjects } from "~/state/mutations";
import { queryKeys } from "~/state/queries";
import { usePalette } from "~/state/ui";
import { useOpenSettings } from "~/components/settings/settingsNavigation";
import { openTaskCounts } from "~/components/board/board.logic";
import { scrollToLane, useBoardFilters, useProjectFilter } from "~/components/board/boardNavigation";
import { moveAmongVisible } from "./projectsOrder.logic";

const NO_PROJECTS: ReadonlyArray<string> = [];

const collisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : closestCorners(args);
};

/** "Projects": drag to reorder lanes, click to jump to a lane. With some projects ticked, only those are listed. */
export function ProjectsSection({ board }: { board: BoardSnapshot }) {
  const [expanded, setExpanded] = useState(true);
  const queryClient = useQueryClient();
  const reorderProjects = useReorderProjects();
  // In-progress-only looks across every project, so the project scope waits and every project is listed.
  const inProgressOnly = useBoardFilters().inProgress;
  const projectFilter = useProjectFilter();
  const scope = inProgressOnly ? NO_PROJECTS : projectFilter;
  const { isMobile, setOpenMobile } = useSidebar();
  const counts = useMemo(() => openTaskCounts(board.tasks), [board.tasks]);
  const suppressClickRef = useRef(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const allIds = useMemo(() => board.projects.map((p) => p.id), [board.projects]);
  const projects = useMemo(
    () => (scope.length ? board.projects.filter((p) => scope.includes(p.id)) : board.projects),
    [board.projects, scope],
  );
  const ids = useMemo(() => projects.map((p) => p.id), [projects]);

  const handleDragEnd = (event: DragEndEvent) => {
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const nextIds = moveAmongVisible(allIds, ids, String(active.id), String(over.id));
    if (!nextIds) return;
    // Optimistic order; the server's project.upserted events carry the new positions.
    queryClient.setQueryData<BoardSnapshot>(queryKeys.board, (current) => {
      if (!current) return current;
      const byId = new Map(current.projects.map((p) => [p.id, p]));
      return { ...current, projects: nextIds.flatMap((id) => byId.get(id) ?? []) };
    });
    reorderProjects.mutate(nextIds, {
      onError: () => void queryClient.invalidateQueries({ queryKey: queryKeys.board }),
    });
  };

  const handleSelect = (projectId: string) => {
    if (suppressClickRef.current) return;
    scrollToLane(projectId);
    if (isMobile) setOpenMobile(false);
  };

  return (
    <SidebarGroup>
      <CollapsibleSectionHeader expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        Projects
      </CollapsibleSectionHeader>
      {!expanded ? null : projects.length === 0 ? (
        <div className="flex flex-col items-start gap-2 px-2 py-2">
          <p className="text-xs text-sidebar-muted-foreground">Projects become swimlanes on the board.</p>
          <Button
            variant="outline"
            size="xs"
            onClick={() => usePalette.getState().openPalette({ kind: "add-project" })}
          >
            <FolderPlusIcon />
            Add a project
          </Button>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
          onDragStart={() => {
            suppressClickRef.current = true;
          }}
          onDragEnd={handleDragEnd}
          onDragCancel={() => {
            window.setTimeout(() => {
              suppressClickRef.current = false;
            }, 0);
          }}
        >
          <SidebarMenu>
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              {projects.map((project) => (
                <SortableProjectRow
                  key={project.id}
                  project={project}
                  openCount={counts.get(project.id) ?? 0}
                  active={scope.includes(project.id)}
                  onSelect={handleSelect}
                />
              ))}
            </SortableContext>
          </SidebarMenu>
        </DndContext>
      )}
    </SidebarGroup>
  );
}

const SortableProjectRow = memo(function SortableProjectRow({
  project,
  openCount,
  active,
  onSelect,
}: {
  project: Project;
  openCount: number;
  active: boolean;
  onSelect: (projectId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({
    id: project.id,
  });
  const openSettingsPage = useOpenSettings();
  const openSettings = () => openSettingsPage("project", { project: project.id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group/menu-item relative rounded-md",
        isDragging && "z-20 opacity-80",
        isOver && !isDragging && "ring-1 ring-inset ring-primary/40",
      )}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      <SidebarMenuButton
        {...attributes}
        {...listeners}
        isActive={active}
        onClick={() => onSelect(project.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          openSettings();
        }}
      >
        <ProjectFavicon title={project.title} icon={project.icon} className="size-4" />
        <span className="min-w-0 flex-1 truncate">{project.title}</span>
        <span className="ms-auto shrink-0 pe-0.5 text-xs tabular-nums text-sidebar-muted-foreground/70 group-focus-within/menu-item:opacity-0 group-hover/menu-item:opacity-0">
          {openCount > 0 ? openCount : ""}
        </span>
      </SidebarMenuButton>
      <Button
        variant="ghost-muted"
        size="icon-xs"
        aria-label={`Project settings for ${project.title}`}
        className="absolute end-1 top-1/2 -translate-y-1/2 opacity-0 group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100"
        onClick={openSettings}
      >
        <SettingsIcon className="size-3.5" />
      </Button>
    </li>
  );
});
