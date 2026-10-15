import { closestCenter, DndContext, type DragEndEvent } from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronsDownUpIcon, ChevronsUpDownIcon, GripVerticalIcon, PanelTopIcon, RotateCcwIcon } from "lucide-react";
import { useId } from "react";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useSectionLayout, useTaskPanelPrefs } from "~/state/ui";
import { useSortableSensors } from "./ManagedSections";
import { SECTION_TITLES, type SectionId } from "./sections.logic";

const modifiers = [restrictToVerticalAxis, restrictToParentElement];

/** Top-bar popover to reorder, show and hide the panel's sections, and collapse or expand them all. */
export function SectionsMenu() {
  const layout = useSectionLayout();
  const move = useTaskPanelPrefs((s) => s.moveSection);
  const setAllCollapsed = useTaskPanelPrefs((s) => s.setAllSectionsCollapsed);
  const reset = useTaskPanelPrefs((s) => s.resetSections);
  const sensors = useSortableSensors();

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) move(active.id as SectionId, over.id as SectionId);
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
          <p className="px-1 text-2xs font-medium text-muted-foreground">Sections</p>
          <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={modifiers} onDragEnd={onDragEnd}>
            <SortableContext items={layout.order} strategy={verticalListSortingStrategy}>
              <ul className="flex flex-col gap-0.5">
                {layout.order.map((id) => (
                  <SectionRow key={id} id={id} hidden={layout.hidden.includes(id)} />
                ))}
              </ul>
            </SortableContext>
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
              title="Reset: default order, all shown, collapsed when empty"
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

function SectionRow({ id, hidden }: { id: SectionId; hidden: boolean }) {
  const setHidden = useTaskPanelPrefs((s) => s.setSectionHidden);
  const { setNodeRef, setActivatorNodeRef, transform, transition, isDragging, attributes, listeners } = useSortable({
    id,
  });
  const labelId = useId();
  const title = SECTION_TITLES[id];
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-md bg-popover pe-1 text-xs",
        isDragging && "relative z-10 shadow-md ring-1 ring-border",
      )}
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
      <Switch
        size="sm"
        aria-labelledby={labelId}
        checked={!hidden}
        onCheckedChange={(shown) => setHidden(id, !shown)}
      />
    </li>
  );
}
