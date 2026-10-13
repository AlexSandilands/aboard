import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { PlanStep, TaskDetail } from "@repo/contracts";
import { ClipboardPasteIcon, EllipsisIcon, ListTodoIcon, ListTreeIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "~/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import {
  isPhaseOpenByDefault,
  moveStepInOrder,
  PHASE_DROP_PREFIX,
  phaseOfStep,
  phaseOfTarget,
  samePlacement,
  stepOrderOf,
  type StepOrder,
} from "./plan.logic";
import type { PlanEditorMode } from "./PlanEditor";
import { PlanPhaseGroup } from "./PlanPhaseGroup";
import { PlanStepDragPreview } from "./PlanStepRow";
import { TaskSection } from "./TaskSection";
import type { PlanActions } from "./usePlanActions";

const modifiers = [restrictToVerticalAxis];

/** The plan as collapsible phases of steps on a vertical rail, with a "you are here" marker. */
export function PlanTimeline({
  task,
  actions,
  onOpenEditor,
}: {
  task: TaskDetail;
  actions: PlanActions;
  onOpenEditor: (mode: PlanEditorMode) => void;
}) {
  const hasPhases = task.phases.length > 0;
  return (
    <TaskSection
      title="Plan"
      actions={
        hasPhases ? (
          <>
            <span className="text-2xs tabular-nums text-muted-foreground">
              {task.progress.done}/{task.progress.total}
            </span>
            <Menu>
              <MenuTrigger
                render={<Button variant="ghost-muted" size="icon-xs" aria-label="Plan actions" />}
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => onOpenEditor("outline")}>
                  <ListTreeIcon />
                  Edit as outline
                </MenuItem>
                <MenuItem onClick={() => onOpenEditor("paste")}>
                  <ClipboardPasteIcon />
                  Replace with pasted markdown
                </MenuItem>
              </MenuPopup>
            </Menu>
          </>
        ) : null
      }
    >
      {hasPhases ? (
        <PlanPhases task={task} actions={actions} />
      ) : (
        <Empty size="compact">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ListTodoIcon />
            </EmptyMedia>
            <EmptyTitle>No plan yet</EmptyTitle>
            <EmptyDescription>Plans turn ideas into tasks. Write one here or let an agent create it.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => onOpenEditor("outline")}>
                Write plan
              </Button>
              <Button size="sm" variant="outline" onClick={() => onOpenEditor("paste")}>
                <ClipboardPasteIcon />
                Paste plan
              </Button>
            </div>
          </EmptyContent>
        </Empty>
      )}
    </TaskSection>
  );
}

function PlanPhases({ task, actions }: { task: TaskDetail; actions: PlanActions }) {
  const currentStepId = task.currentStep?.id ?? null;
  /** Explicit open/closed per phase; unset phases follow isPhaseOpenByDefault. */
  const [openPhases, setOpenPhases] = useState<Record<string, boolean>>({});
  const [drag, setDrag] = useState<{ stepId: string; order: StepOrder; overPhaseHeader: string | null } | null>(null);

  const baseOrder = useMemo(() => stepOrderOf(task.phases), [task.phases]);
  const stepsById = useMemo(() => new Map(task.phases.flatMap((p) => p.steps).map((s) => [s.id, s])), [task.phases]);
  const order = drag?.order ?? baseOrder;
  const activeStep = drag ? stepsById.get(drag.stepId) : undefined;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragStart = ({ active }: DragStartEvent) =>
    setDrag({ stepId: String(active.id), order: baseOrder, overPhaseHeader: null });

  // Cross-phase moves happen live so the target list opens a gap; same-phase sorting is
  // animated by dnd-kit and committed on drop. Headers are resolved on drop only, since
  // moving into a collapsed phase would unmount the dragged row.
  const onDragOver = ({ active, over }: DragOverEvent) => {
    setDrag((current) => {
      if (!current) return current;
      const overId = over ? String(over.id) : null;
      const overPhaseHeader = overId?.startsWith(PHASE_DROP_PREFIX) ? overId.slice(PHASE_DROP_PREFIX.length) : null;
      let nextOrder = current.order;
      if (overId && !overPhaseHeader) {
        const from = phaseOfStep(current.order, String(active.id));
        const to = phaseOfTarget(current.order, overId);
        if (from && to && from !== to) nextOrder = moveStepInOrder(current.order, String(active.id), overId);
      }
      if (nextOrder === current.order && overPhaseHeader === current.overPhaseHeader) return current;
      return { ...current, order: nextOrder, overPhaseHeader };
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const current = drag;
    setDrag(null);
    if (!current || !over) return;
    const stepId = String(active.id);
    const finalOrder = moveStepInOrder(current.order, stepId, String(over.id));
    if (samePlacement(baseOrder, finalOrder, stepId)) return;
    const targetPhase = phaseOfStep(finalOrder, stepId);
    if (targetPhase) setOpenPhases((open) => ({ ...open, [targetPhase]: true }));
    actions.moveStep(stepId, finalOrder);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={modifiers}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDrag(null)}
    >
      <div className="flex flex-col gap-0.5">
        {task.phases.map((phase, index) => {
          const steps = (order[phase.id] ?? [])
            .map((id) => stepsById.get(id))
            .filter((s): s is PlanStep => s !== undefined);
          return (
            <PlanPhaseGroup
              key={phase.id}
              phase={phase}
              phaseIndex={index}
              steps={steps}
              currentStepId={currentStepId}
              open={openPhases[phase.id] ?? isPhaseOpenByDefault(phase, currentStepId)}
              onOpenChange={(open) => setOpenPhases((current) => ({ ...current, [phase.id]: open }))}
              dropHighlight={
                drag?.overPhaseHeader === phase.id && phaseOfStep(drag.order, drag.stepId) !== phase.id
              }
              actions={actions}
            />
          );
        })}
        <AddPhaseRow onAdd={(title) => actions.addPhase(title)} />
      </div>
      {/* Portaled so the scroll area's fade mask doesn't clip the dragged row. */}
      {createPortal(
        <DragOverlay dropAnimation={null}>{activeStep ? <PlanStepDragPreview step={activeStep} /> : null}</DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

function AddPhaseRow({ onAdd }: { onAdd: (title: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  if (adding) {
    const submit = () => {
      const title = draft.trim();
      if (title) onAdd(title);
      setDraft("");
      setAdding(false);
    };
    return (
      <div className="flex items-center gap-1.5 ps-1 pe-1 pt-1">
        <PlusIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
        <Input
          autoFocus
          aria-label="New phase title"
          size="sm"
          value={draft}
          placeholder="Phase title"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setDraft("");
              setAdding(false);
            }
          }}
          onBlur={submit}
        />
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setAdding(true)}
      className={cn(
        "mt-1 flex h-8 w-full items-center gap-1.5 rounded-lg ps-1 text-left text-[13px] font-medium text-muted-foreground/70 outline-none hover:bg-black/[0.035] hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:hover:bg-white/[0.04]",
      )}
    >
      <PlusIcon className="size-3.5" />
      Add phase
    </button>
  );
}
