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
import type { AttentionReason, TaskDetail } from "@repo/contracts";
import { GripVerticalIcon } from "lucide-react";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "~/lib/utils";
import { useSettings } from "~/state/queries";
import { useSectionLayout, useTaskPanelPrefs } from "~/state/ui";
import {
  collapsedByDefault,
  SECTION_TITLES,
  sectionAttention,
  sectionsInColumn,
  summarizeSection,
  SECTION_COLUMNS,
  type SectionColumn,
  type SectionId,
} from "./sections.logic";
import { useTaskLayout } from "./taskLayout";

const modifiers = [restrictToVerticalAxis];

/** What a managed TaskSection needs from its slot: open state, the collapsed summary and a drag handle. */
export interface SectionFrame {
  id: SectionId;
  expanded: boolean;
  onToggle: () => void;
  summary: string;
  /** The task's warning for this section, set only while it is collapsed (open, the content shows it). */
  attention: AttentionReason | null;
  dragHandle: ReactNode;
  /**
   * A side-column section moved to the task window's main column: its rows are made for a panel's width, so its
   * header and content stop at about that width instead of spreading a row's ends across the window.
   */
  capped: boolean;
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
 * component renders a TaskSection, which picks up its frame from context. With `column` (the task window's two
 * columns) only that column's sections show, and a drag reorders them within it.
 */
export function ManagedSections({
  task,
  column,
  exclude,
  render,
}: {
  task: TaskDetail;
  column?: SectionColumn;
  /** Sections that don't apply to this task (an epic's plan), left out whatever the layout says. */
  exclude?: ReadonlyArray<SectionId>;
  render: (id: SectionId) => ReactNode;
}) {
  const layout = useSectionLayout();
  const move = useTaskPanelPrefs((s) => s.moveSection);
  const showAll = useTaskPanelPrefs((s) => s.showAllSections);
  const sensors = useSortableSensors();
  const [dragging, setDragging] = useState<SectionId | null>(null);
  const order = sectionsInColumn(layout.order, column, layout.columns);
  const visible = order.filter((id) => !layout.hidden.includes(id) && !exclude?.includes(id));
  const hiddenCount = sectionsInColumn(layout.hidden, column, layout.columns).length;

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
      {hiddenCount ? (
        <p className="border-t border-border/65 px-3.5 pt-3 text-2xs text-muted-foreground">
          {hiddenCount === 1 ? "1 hidden section" : `${hiddenCount} hidden sections`} ·{" "}
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
  const globalReview = useSettings().data?.autoReview ?? false;
  const capped = useTaskLayout().column === "main" && SECTION_COLUMNS[id] === "rail";
  const summary = expanded ? "" : summarizeSection(id, task, undefined, globalReview);
  const attention = expanded ? null : sectionAttention(id, task);
  const frame = useMemo<SectionFrame>(
    () => ({
      id,
      expanded,
      onToggle: () => setCollapsed(id, expanded, byDefault),
      summary,
      attention,
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
      capped,
    }),
    [id, expanded, byDefault, summary, attention, capped, setCollapsed, setActivatorNodeRef, attributes, listeners],
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
