import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { TaskDetail } from "@repo/contracts";
import { GripVerticalIcon } from "lucide-react";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "~/lib/utils";
import { useSectionLayout, useTaskPanelPrefs } from "~/state/ui";
import { collapsedByDefault, SECTION_TITLES, summarizeSection, type SectionId } from "./sections.logic";

const modifiers = [restrictToVerticalAxis];

/** What a managed TaskSection needs from its slot: open state, the collapsed summary and a drag handle. */
export interface SectionFrame {
  id: SectionId;
  expanded: boolean;
  onToggle: () => void;
  summary: string;
  dragHandle: ReactNode;
}

const SectionFrameContext = createContext<SectionFrame | null>(null);

export const useSectionFrame = () => useContext(SectionFrameContext);

export function useSortableSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

/**
 * Saved choice, else the smart default for this task. The default is taken when the section mounts (the
 * panel remounts per task), so removing the last link doesn't snap Links shut while it's in use.
 */
function useSectionExpanded(id: SectionId, task: TaskDetail) {
  const [byDefault] = useState(() => collapsedByDefault(id, task));
  const saved = useSectionLayout().collapsed[id];
  return { expanded: !(saved ?? byDefault), byDefault };
}

/**
 * The detail panel's reorderable sections in the saved order, hidden ones skipped. Each section's
 * component renders a TaskSection, which picks up its frame from context.
 */
export function ManagedSections({
  task,
  exclude,
  render,
}: {
  task: TaskDetail;
  /** Sections that don't apply to this task (an epic's plan), left out whatever the layout says. */
  exclude?: ReadonlyArray<SectionId>;
  render: (id: SectionId) => ReactNode;
}) {
  const layout = useSectionLayout();
  const move = useTaskPanelPrefs((s) => s.moveSection);
  const showAll = useTaskPanelPrefs((s) => s.showAllSections);
  const sensors = useSortableSensors();
  const [dragging, setDragging] = useState<SectionId | null>(null);
  const visible = layout.order.filter((id) => !layout.hidden.includes(id) && !exclude?.includes(id));

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    if (over && active.id !== over.id) move(active.id as SectionId, over.id as SectionId);
  };

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={modifiers}
        onDragStart={({ active }) => setDragging(active.id as SectionId)}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <SortableContext items={visible} strategy={verticalListSortingStrategy}>
          {visible.map((id) => (
            <ManagedSection key={id} id={id} task={task}>
              {render(id)}
            </ManagedSection>
          ))}
        </SortableContext>
        {/* Portaled so the scroll area's fade mask doesn't clip it. */}
        {createPortal(
          <DragOverlay dropAnimation={null}>
            {dragging ? <SectionDragPreview title={SECTION_TITLES[dragging]} /> : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
      {layout.hidden.length ? (
        <p className="border-t border-border/65 px-3.5 pt-3 text-2xs text-muted-foreground">
          {layout.hidden.length === 1 ? "1 hidden section" : `${layout.hidden.length} hidden sections`} ·{" "}
          <button
            type="button"
            className="cursor-pointer rounded-sm underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            onClick={showAll}
          >
            Show
          </button>
        </p>
      ) : null}
    </>
  );
}

function ManagedSection({ id, task, children }: { id: SectionId; task: TaskDetail; children: ReactNode }) {
  const { expanded, byDefault } = useSectionExpanded(id, task);
  const setCollapsed = useTaskPanelPrefs((s) => s.setSectionCollapsed);
  const { setNodeRef, setActivatorNodeRef, transform, transition, isDragging, attributes, listeners } = useSortable({
    id,
  });
  const summary = expanded ? "" : summarizeSection(id, task);
  const frame = useMemo<SectionFrame>(
    () => ({
      id,
      expanded,
      onToggle: () => setCollapsed(id, expanded, byDefault),
      summary,
      dragHandle: (
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${SECTION_TITLES[id]} section`}
          className="absolute top-3.5 left-0 flex h-5 w-3.5 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 opacity-0 outline-none group-hover/section:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing pointer-coarse:opacity-100"
        >
          <GripVerticalIcon className="size-3" />
        </button>
      ),
    }),
    [id, expanded, byDefault, summary, setCollapsed, setActivatorNodeRef, attributes, listeners],
  );
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("relative", isDragging && "z-10 opacity-40")}
    >
      <SectionFrameContext.Provider value={frame}>{children}</SectionFrameContext.Provider>
    </div>
  );
}

function SectionDragPreview({ title }: { title: string }) {
  return (
    <div className="flex h-8 items-center gap-2 rounded-lg border border-border bg-popover px-2 text-xs font-medium shadow-lg">
      <GripVerticalIcon className="size-3.5 text-muted-foreground" />
      {title}
    </div>
  );
}
