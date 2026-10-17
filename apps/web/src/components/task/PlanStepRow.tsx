import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { PlanStep, StepStatus } from "@repo/contracts";
import {
  ChevronRightIcon,
  EllipsisIcon,
  GripVerticalIcon,
  NotebookPenIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { Markdown } from "~/components/markdown/Markdown";
import { useTaskLinks } from "~/components/markdown/useTaskLinks";
import { Badge } from "~/components/ui/badge";
import { InlineButton } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { formatRelativeTimeLabel } from "~/lib/timestampFormat";
import { cn } from "~/lib/utils";
import { InlineInput } from "./InlineInput";
import { AttachmentThumbs } from "~/components/attachments/AttachmentThumbs";
import { MarkdownEditor } from "./MarkdownEditor";
import { cycleStepStatus, railSegmentTone, STEP_STATUS_LABELS, type RailTone } from "./plan.logic";
import { STEP_TITLE_TONE, StepStatusGlyph } from "./StepVisuals";
import type { PlanActions } from "./usePlanActions";

const RAIL_TONE: Record<RailTone, string> = {
  success: "bg-success/40",
  primary: "bg-primary/50",
  default: "bg-border",
};

const MENU_STATUSES: StepStatus[] = ["todo", "in_progress", "done", "blocked", "skipped"];

/*
 * Row geometry: the rail column stretches the full row height. The node sits 6px from
 * the top (centred on the 32px title line); the segments above and below it reach the
 * row edges, so consecutive rows draw one continuous line.
 */

export function PlanStepRow({
  step,
  label,
  isCurrent,
  prevStatus,
  nextStatus,
  actions,
  onInteract,
}: {
  step: PlanStep;
  /** "1.2" */
  label: string;
  isCurrent: boolean;
  prevStatus: StepStatus | null;
  nextStatus: StepStatus | null;
  actions: PlanActions;
  /** Called on any edit, so the parent can pin the phase open. */
  onInteract: () => void;
}) {
  const { setNodeRef, transform, transition, isDragging, attributes, listeners } = useSortable({ id: step.id });
  const [expanded, setExpanded] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingNotes, setEditingNotes] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const taskLinks = useTaskLinks();
  const hasNotes = !!step.notes?.trim();

  const setStatus = (status: StepStatus) => {
    onInteract();
    actions.setStepStatus(step.id, status);
  };
  const editNotes = () => {
    setExpanded(true);
    setEditingNotes(true);
  };

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("group/step relative", isDragging && "z-10 opacity-40")}
    >
      <div
        className={cn(
          "relative flex items-stretch rounded-lg pe-1",
          // Inset ring: the collapsible panel clips overflow.
          isCurrent && "bg-primary/6 ring-1 ring-inset ring-primary/20",
        )}
        onContextMenu={(event) => {
          if ((event.target as HTMLElement).closest("input, textarea, a, [contenteditable='true']")) return;
          event.preventDefault();
          setMenuOpen(true);
        }}
      >
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${label} ${step.title}`}
          className="mt-1.5 flex size-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 opacity-0 outline-none group-hover/step:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing pointer-coarse:opacity-100"
        >
          <GripVerticalIcon className="size-3.5" />
        </button>

        <div className="relative flex w-6 shrink-0 justify-center">
          {prevStatus ? (
            <span
              aria-hidden
              className={cn(
                "absolute top-0 left-1/2 h-1.5 w-px -translate-x-1/2",
                RAIL_TONE[railSegmentTone(prevStatus, step.status)],
              )}
            />
          ) : null}
          {nextStatus ? (
            <span
              aria-hidden
              className={cn(
                "absolute top-[26px] bottom-0 left-1/2 w-px -translate-x-1/2",
                RAIL_TONE[railSegmentTone(step.status, nextStatus)],
              )}
            />
          ) : null}
          <StepNode step={step} onCycle={() => setStatus(cycleStepStatus(step.status))} />
        </div>

        <div className="min-w-0 flex-1 ps-1.5">
          <div className="flex min-h-8 items-center gap-2">
            {editingTitle ? (
              <InlineInput
                ariaLabel="Step title"
                size="sm"
                value={step.title}
                onCommit={(title) => {
                  setEditingTitle(false);
                  onInteract();
                  actions.renameStep(step.id, title);
                }}
                onCancel={() => setEditingTitle(false)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditingTitle(true)}
                className={cn(
                  "min-w-0 cursor-text rounded-sm py-1 text-left text-[13px] leading-snug wrap-anywhere outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  STEP_TITLE_TONE[step.status],
                  isCurrent && "font-medium",
                )}
              >
                <span className="sr-only">{STEP_STATUS_LABELS[step.status]}: </span>
                {step.title}
              </button>
            )}
            {isCurrent && !editingTitle ? (
              <Badge variant="default" size="sm">
                Now
              </Badge>
            ) : null}
          </div>

          {expanded ? (
            <div className="pb-2">
              {editingNotes ? (
                <MarkdownEditor
                  taskId={actions.taskId}
                  ariaLabel={`Notes for ${step.title}`}
                  value={step.notes ?? ""}
                  placeholder="Notes, decisions, gotchas… (markdown)"
                  onSave={(notes) => {
                    setEditingNotes(false);
                    if (notes !== (step.notes?.trim() || null)) {
                      onInteract();
                      actions.setStepNotes(step.id, notes);
                    }
                  }}
                  onCancel={() => setEditingNotes(false)}
                />
              ) : (
                <div className="flex flex-col items-start gap-1">
                  {hasNotes ? (
                    <>
                      <Markdown size="xs" taskLinks={taskLinks}>
                        {step.notes!}
                      </Markdown>
                      <AttachmentThumbs text={step.notes} />
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground/70">No notes yet.</span>
                  )}
                  <span className="text-xs">
                    <InlineButton tone="muted" onClick={editNotes}>
                      <NotebookPenIcon className="size-3" />
                      Edit notes
                    </InlineButton>
                  </span>
                </div>
              )}
            </div>
          ) : null}
        </div>

        <div className="flex h-8 shrink-0 items-center gap-0.5">
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? "Hide notes" : hasNotes ? "Show notes" : "Add notes"}
            onClick={() => {
              setExpanded((value) => !value);
              setEditingNotes(false);
            }}
            className={cn(
              "flex size-6 items-center justify-center rounded-md text-muted-foreground/70 outline-none hover:bg-black/[0.035] hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:hover:bg-white/[0.08]",
              !hasNotes &&
                !expanded &&
                "opacity-0 group-hover/step:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
            )}
          >
            <ChevronRightIcon className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
          </button>
          <Menu open={menuOpen} onOpenChange={setMenuOpen}>
            <MenuTrigger
              aria-label={`Actions for ${step.title}`}
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none group-hover/step:opacity-100 hover:bg-black/[0.035] hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:opacity-100 dark:hover:bg-white/[0.08] pointer-coarse:opacity-100"
            >
              <EllipsisIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end">
              {MENU_STATUSES.filter((status) => status !== step.status).map((status) => (
                <MenuItem key={status} onClick={() => setStatus(status)}>
                  <span className="flex size-4 items-center justify-center">
                    <StepStatusGlyph status={status} size="sm" />
                  </span>
                  Mark {STEP_STATUS_LABELS[status].toLowerCase()}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem onClick={() => setEditingTitle(true)}>
                <PencilIcon />
                Rename
              </MenuItem>
              <MenuItem onClick={editNotes}>
                <NotebookPenIcon />
                Edit notes
              </MenuItem>
              <MenuSeparator />
              <MenuItem variant="destructive" onClick={() => actions.deleteStep(step.id)}>
                <Trash2Icon />
                Delete step
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
    </li>
  );
}

function StepNode({ step, onCycle }: { step: PlanStep; onCycle: () => void }) {
  const next = cycleStepStatus(step.status);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onCycle}
            aria-label={`${STEP_STATUS_LABELS[step.status]}. Mark ${STEP_STATUS_LABELS[next].toLowerCase()}`}
            className="relative mt-1.5 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <StepStatusGlyph status={step.status} />
      </TooltipTrigger>
      <TooltipPopup side="left">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{STEP_STATUS_LABELS[step.status]}</span>
          {step.startedAt ? (
            <span className="text-muted-foreground">Started {formatRelativeTimeLabel(step.startedAt)}</span>
          ) : null}
          {step.completedAt ? (
            <span className="text-muted-foreground">
              {step.status === "skipped" ? "Skipped" : "Completed"} {formatRelativeTimeLabel(step.completedAt)}
            </span>
          ) : null}
          <span className="text-muted-foreground">Click to mark {STEP_STATUS_LABELS[next].toLowerCase()}</span>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

/** Lightweight copy of a step shown under the pointer while dragging. */
export function PlanStepDragPreview({ step }: { step: PlanStep }) {
  return (
    <div className="flex h-8 items-center gap-2 rounded-lg border border-border bg-popover px-2 shadow-lg">
      <GripVerticalIcon className="size-3.5 text-muted-foreground" />
      <StepStatusGlyph status={step.status} />
      <span className={cn("min-w-0 truncate text-[13px]", STEP_TITLE_TONE[step.status])}>{step.title}</span>
    </div>
  );
}
