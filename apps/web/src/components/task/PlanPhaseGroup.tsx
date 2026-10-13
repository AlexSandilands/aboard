import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { PlanPhase, PlanStep } from "@repo/contracts";
import { ChevronRightIcon, EllipsisIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import { ConfirmDialog } from "./ConfirmDialog";
import { InlineInput } from "./InlineInput";
import { PHASE_DROP_PREFIX } from "./plan.logic";
import { PlanStepRow } from "./PlanStepRow";
import { StepSegments } from "./StepVisuals";
import type { PlanActions } from "./usePlanActions";

const HOVER_SURFACE = "hover:bg-black/[0.035] dark:hover:bg-white/[0.04]";

export function PlanPhaseGroup({
  phase,
  phaseIndex,
  steps,
  currentStepId,
  open,
  onOpenChange,
  dropHighlight,
  actions,
}: {
  phase: PlanPhase;
  phaseIndex: number;
  /** Steps in display order (may differ from `phase.steps` mid-drag). */
  steps: ReadonlyArray<PlanStep>;
  currentStepId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A step from another phase is hovering this phase's header. */
  dropHighlight: boolean;
  actions: PlanActions;
}) {
  const [renaming, setRenaming] = useState(false);
  const [addingStep, setAddingStep] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const droppable = useDroppable({ id: `${PHASE_DROP_PREFIX}${phase.id}` });

  const statuses = steps.map((s) => s.status);
  const done = statuses.filter((s) => s === "done" || s === "skipped").length;
  const complete = steps.length > 0 && done === steps.length;
  const pinOpen = () => {
    if (!open) return;
    onOpenChange(true);
  };

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div
        ref={droppable.setNodeRef}
        className={cn(
          "group/row flex h-8 min-w-0 items-center gap-1.5 rounded-lg pe-1",
          HOVER_SURFACE,
          dropHighlight && "bg-primary/6 ring-1 ring-primary/30",
        )}
      >
        {renaming ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5 ps-1">
            <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground", open && "rotate-90")} />
            <InlineInput
              ariaLabel="Phase title"
              size="sm"
              value={phase.title}
              onCommit={(title) => {
                setRenaming(false);
                actions.renamePhase(phase.id, title);
              }}
              onCancel={() => setRenaming(false)}
            />
          </div>
        ) : (
          <CollapsibleTrigger
            onDoubleClick={() => setRenaming(true)}
            className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg ps-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <ChevronRightIcon
              className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
            />
            <span className="shrink-0 font-mono text-2xs text-muted-foreground/60 tabular-nums">{phaseIndex + 1}</span>
            <span
              className={cn(
                "min-w-0 truncate text-[13px] font-medium",
                complete ? "text-muted-foreground/70" : "text-foreground/85",
              )}
            >
              {phase.title}
            </span>
          </CollapsibleTrigger>
        )}
        <span
          className={cn(
            "shrink-0 text-2xs tabular-nums",
            complete ? "text-success-foreground" : "text-muted-foreground",
          )}
        >
          {done}/{steps.length}
        </span>
        <StepSegments statuses={statuses} />
        <Menu>
          <MenuTrigger
            aria-label={`Actions for phase ${phase.title}`}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:opacity-100 pointer-coarse:opacity-100"
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => setRenaming(true)}>
              <PencilIcon />
              Rename phase
            </MenuItem>
            <MenuItem
              onClick={() => {
                onOpenChange(true);
                setAddingStep(true);
              }}
            >
              <PlusIcon />
              Add step
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              variant="destructive"
              onClick={() => (steps.length > 0 ? setConfirmDelete(true) : actions.deletePhase(phase.id))}
            >
              <Trash2Icon />
              Delete phase
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>

      <CollapsiblePanel>
        <SortableContext id={phase.id} items={steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <ol className="flex flex-col pt-0.5">
            {steps.map((step, index) => (
              <PlanStepRow
                key={step.id}
                step={step}
                label={`${phaseIndex + 1}.${index + 1}`}
                isCurrent={step.id === currentStepId}
                prevStatus={steps[index - 1]?.status ?? null}
                nextStatus={steps[index + 1]?.status ?? null}
                actions={actions}
                onInteract={pinOpen}
              />
            ))}
          </ol>
        </SortableContext>
        <AddStepRow
          adding={addingStep}
          onAddingChange={setAddingStep}
          onAdd={(title) => actions.addStep(phase.id, title)}
        />
      </CollapsiblePanel>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${phase.title}”?`}
        description={`Its ${steps.length === 1 ? "step" : `${steps.length} steps`} will be deleted too. This can't be undone.`}
        confirmLabel="Delete phase"
        onConfirm={() => actions.deletePhase(phase.id)}
      />
    </Collapsible>
  );
}

/** Ghost "+ Add step" row; Enter adds and keeps the input focused for the next one. */
function AddStepRow({
  adding,
  onAddingChange,
  onAdd,
}: {
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
  onAdd: (title: string) => void;
}) {
  const [draft, setDraft] = useState("");
  if (!adding) {
    return (
      <button
        type="button"
        onClick={() => onAddingChange(true)}
        className={cn(
          "flex h-7 w-full items-center gap-1.5 rounded-lg ps-5 text-left text-xs text-muted-foreground/70 outline-none hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          HOVER_SURFACE,
        )}
      >
        <span className="flex w-6 justify-center">
          <PlusIcon className="size-3.5" />
        </span>
        Add step
      </button>
    );
  }
  const submit = () => {
    const title = draft.trim();
    if (title) onAdd(title);
    setDraft("");
  };
  return (
    <div className="flex items-center gap-1.5 py-0.5 ps-5 pe-1">
      <span className="flex w-6 shrink-0 justify-center">
        <PlusIcon className="size-3.5 text-muted-foreground/70" />
      </span>
      <Input
        autoFocus
        aria-label="New step title"
        size="sm"
        value={draft}
        placeholder="New step — Enter to add, Esc to finish"
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDraft("");
            onAddingChange(false);
          }
        }}
        onBlur={() => {
          submit();
          onAddingChange(false);
        }}
      />
    </div>
  );
}
