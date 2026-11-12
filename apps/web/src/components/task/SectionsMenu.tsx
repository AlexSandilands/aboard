import {
  closestCenter,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  pointerWithin,
  useDroppable,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowLeftToLineIcon,
  ArrowRightToLineIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  GripVerticalIcon,
  PanelTopIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useId, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useSectionLayout, useTaskPanelPrefs } from "~/state/ui";
import { useSortableSensors } from "./ManagedSections";
import {
  SECTION_COLUMN_TITLES,
  SECTION_IDS,
  SECTION_TITLES,
  sectionColumn,
  sectionsInColumn,
  type SectionColumn,
  type SectionId,
  type TaskPanelLayout,
} from "./sections.logic";

const modifiers = [restrictToVerticalAxis];
const WINDOW_COLUMNS = ["main", "rail"] as const;
const OTHER_COLUMN: Record<SectionColumn, SectionColumn> = { main: "rail", rail: "main" };

/** Each column's list is a drop target of its own, so a row can land in an empty one. */
const listDropId = (column: SectionColumn) => `list:${column}`;
const listColumn = (id: unknown): SectionColumn | null =>
  id === listDropId("main") ? "main" : id === listDropId("rail") ? "rail" : null;
const isSectionId = (id: unknown): id is SectionId => SECTION_IDS.includes(id as SectionId);

/**
 * The row under the pointer, else the list it is over (an empty one, or the space below its rows), else the closest
 * row (the keyboard, which has no pointer).
 */
const collisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const row = hits.find((hit) => isSectionId(hit.id));
  if (row) return [row];
  if (hits.length) return hits;
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter((container) => isSectionId(container.id)),
  });
};

/**
 * Top-bar popover to reorder, show and hide the panel's sections, and collapse or expand them all. In the task
 * window it lists them by column, where they sit there: a row dragged into the other list, or sent there with its
 * move button, changes the section's column. The order within each column is the panel's too.
 */
export function SectionsMenu({ layout = "panel" }: { layout?: TaskPanelLayout }) {
  const sections = useSectionLayout();
  const move = useTaskPanelPrefs((s) => s.moveSection);
  const moveToColumn = useTaskPanelPrefs((s) => s.moveSectionToColumn);
  const setAllCollapsed = useTaskPanelPrefs((s) => s.setAllSectionsCollapsed);
  const reset = useTaskPanelPrefs((s) => s.resetSections);
  const sensors = useSortableSensors();
  const [dragging, setDragging] = useState<SectionId | null>(null);
  const inWindow = layout === "window";

  // Crossing into the other list moves the row there as it goes, so that list makes room for it under the pointer.
  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!inWindow || !over || !isSectionId(active.id)) return;
    const overRow = isSectionId(over.id) ? over.id : undefined;
    const column = overRow ? sectionColumn(sections.columns, overRow) : listColumn(over.id);
    if (column && column !== sectionColumn(sections.columns, active.id)) moveToColumn(active.id, column, overRow);
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    if (over && active.id !== over.id && isSectionId(active.id) && isSectionId(over.id)) move(active.id, over.id);
  };

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={<PopoverTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Customize sections" />} />}
        >
          <PanelTopIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Customize sections</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" width="sm" padding="compact">
        <div className="flex flex-col gap-2">
          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            modifiers={modifiers}
            onDragStart={({ active }) => setDragging(active.id as SectionId)}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
            onDragCancel={() => setDragging(null)}
          >
            {inWindow ? (
              WINDOW_COLUMNS.map((column) => <SectionList key={column} column={column} />)
            ) : (
              <SectionList column={undefined} />
            )}
            {/* Portaled: the popup's own transform would offset a fixed overlay inside it. */}
            {createPortal(
              <DragOverlay dropAnimation={null}>
                {dragging ? <SectionRowPreview title={SECTION_TITLES[dragging]} /> : null}
              </DragOverlay>,
              document.body,
            )}
          </DndContext>
          <div className="flex flex-wrap items-center gap-1 border-t border-border/65 pt-2">
            <Button variant="ghost" size="xs" onClick={() => setAllCollapsed(true)}>
              <ChevronsDownUpIcon />
              Collapse all
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setAllCollapsed(false)}>
              <ChevronsUpDownIcon />
              Expand all
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="ms-auto"
              aria-label="Reset sections"
              title={
                inWindow
                  ? "Reset: default order and columns, all shown, collapsed when empty"
                  : "Reset: default order, all shown, collapsed when empty"
              }
              onClick={reset}
            >
              <RotateCcwIcon />
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** One sortable list of rows: every section, or one window column's. */
function SectionList({ column }: { column: SectionColumn | undefined }) {
  const layout = useSectionLayout();
  const ids = sectionsInColumn(layout.order, column, layout.columns);
  const { setNodeRef, isOver } = useDroppable({ id: listDropId(column ?? "main"), disabled: !column });
  const headingId = useId();
  return (
    <div className="flex flex-col gap-1">
      <p id={headingId} className="px-1 text-2xs font-medium text-muted-foreground">
        {column ? SECTION_COLUMN_TITLES[column] : "Sections"}
      </p>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul ref={setNodeRef} aria-labelledby={headingId} className="flex min-h-8 flex-col gap-0.5">
          {ids.map((id) => (
            <SectionRow key={id} id={id} column={column} hidden={layout.hidden.includes(id)} />
          ))}
          {ids.length === 0 ? (
            <li
              className={cn(
                "flex h-8 items-center justify-center rounded-md border border-dashed border-border text-2xs text-muted-foreground",
                isOver && "border-primary/60 bg-primary/6 text-foreground",
              )}
            >
              Drag a section here
            </li>
          ) : null}
        </ul>
      </SortableContext>
    </div>
  );
}

function SectionRow({ id, column, hidden }: { id: SectionId; column: SectionColumn | undefined; hidden: boolean }) {
  const setHidden = useTaskPanelPrefs((s) => s.setSectionHidden);
  const moveToColumn = useTaskPanelPrefs((s) => s.moveSectionToColumn);
  const { setNodeRef, setActivatorNodeRef, transform, transition, isDragging, attributes, listeners } = useSortable({
    id,
  });
  const labelId = useId();
  const title = SECTION_TITLES[id];
  const other = column ? OTHER_COLUMN[column] : null;
  const moveLabel = other === "rail" ? "Move to side column" : "Move to main column";
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("flex h-8 items-center gap-1.5 rounded-md bg-popover pe-1 text-xs", isDragging && "opacity-40")}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${title}`}
        className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
      <span id={labelId} className={cn("min-w-0 flex-1 truncate", hidden && "text-muted-foreground")}>
        {title}
      </span>
      {other ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`${moveLabel}: ${title}`}
                onClick={() => moveToColumn(id, other)}
              />
            }
          >
            {other === "rail" ? <ArrowRightToLineIcon /> : <ArrowLeftToLineIcon />}
          </TooltipTrigger>
          <TooltipPopup side="left">{moveLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
      <Switch
        size="sm"
        aria-labelledby={labelId}
        checked={!hidden}
        onCheckedChange={(shown) => setHidden(id, !shown)}
      />
    </li>
  );
}

function SectionRowPreview({ title }: { title: string }) {
  return (
    <div className="flex h-8 items-center gap-1.5 rounded-md bg-popover pe-2 text-xs shadow-md ring-1 ring-border">
      <span className="flex size-6 items-center justify-center text-muted-foreground">
        <GripVerticalIcon className="size-3.5" />
      </span>
      {title}
    </div>
  );
}
