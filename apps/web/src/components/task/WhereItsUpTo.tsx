import type { TaskDetail } from "@repo/contracts";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  ListTodoIcon,
  MessageSquareQuoteIcon,
  PlayIcon,
} from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Markdown } from "~/components/markdown/Markdown";
import { Button, InlineButton } from "~/components/ui/button";
import { formatRelativeTimeLabel } from "~/lib/timestampFormat";
import { cn } from "~/lib/utils";
import { StepSegments, StepStatusGlyph } from "./StepVisuals";
import type { PlanActions } from "./usePlanActions";

/**
 * The first thing under the title: where the task is up to (the current step, its notes,
 * progress) and the latest handover note, so returning to a task needs no digging.
 */
export function WhereItsUpTo({
  task,
  actions,
  onWritePlan,
}: {
  task: TaskDetail;
  actions: PlanActions;
  onWritePlan: () => void;
}) {
  const current = task.currentStep;
  const step = current ? task.phases.flatMap((p) => p.steps).find((s) => s.id === current.id) : undefined;
  const { done, total } = task.progress;

  let heading: { label: string; tone: string; icon: ReactNode };
  if (total === 0) {
    heading = {
      label: "No plan yet",
      tone: "text-muted-foreground",
      icon: <ListTodoIcon className="size-4 text-muted-foreground" />,
    };
  } else if (!current) {
    heading = {
      label: "Done — all steps complete",
      tone: "text-success-foreground",
      icon: <CircleCheckIcon className="size-4 text-success" />,
    };
  } else if (current.status === "in_progress") {
    heading = { label: "In progress", tone: "text-primary", icon: <StepStatusGlyph status="in_progress" /> };
  } else if (current.status === "blocked") {
    heading = { label: "Blocked", tone: "text-warning-foreground", icon: <StepStatusGlyph status="blocked" /> };
  } else {
    heading = { label: "Up next", tone: "text-foreground/90", icon: <StepStatusGlyph status="todo" /> };
  }

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-3">
      <div className="flex items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center">{heading.icon}</span>
        <span className={cn("min-w-0 truncate text-sm font-semibold", heading.tone)}>{heading.label}</span>
        {total > 0 ? (
          <span className="ms-auto flex shrink-0 items-center gap-2">
            <StepSegments statuses={task.stepStatuses} className="w-24" />
            <span
              className={cn(
                "text-xs tabular-nums",
                done === total ? "text-success-foreground" : "text-muted-foreground",
              )}
            >
              {done}/{total}
            </span>
          </span>
        ) : null}
      </div>

      {current ? (
        <div className="mt-2 flex items-start gap-3 ps-7">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-1 text-[13px] leading-snug">
              <span className="text-muted-foreground">{current.phaseTitle}</span>
              <ChevronRightIcon aria-label="›" className="size-3 shrink-0 text-muted-foreground/60" />
              <span className="font-medium text-foreground/90 wrap-anywhere">{current.title}</span>
              <span className="ms-1 font-mono text-2xs text-muted-foreground/60 tabular-nums">{current.index}</span>
            </div>
            {step?.notes?.trim() ? <ClampedMarkdown key={step.id} text={step.notes} /> : null}
          </div>
          {current.status === "todo" ? (
            <Button size="xs" variant="outline" onClick={() => actions.setStepStatus(current.id, "in_progress")}>
              <PlayIcon />
              Start
            </Button>
          ) : current.status === "in_progress" ? (
            <Button size="xs" variant="outline" onClick={() => actions.setStepStatus(current.id, "done")}>
              <CheckIcon />
              Mark done
            </Button>
          ) : null}
        </div>
      ) : total === 0 ? (
        <div className="mt-2 flex items-center gap-3 ps-7">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            {task.status === "idea" ? "Ideas need a plan before they can move on." : "This task has no steps."}
          </p>
          <Button size="xs" variant="outline" onClick={onWritePlan}>
            Write plan
          </Button>
        </div>
      ) : null}

      {task.lastNote ? (
        <div className="mt-3 border-t border-border/50 pt-2.5">
          <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <MessageSquareQuoteIcon className="size-3.5 shrink-0" />
            <span className="font-medium">Last handover</span>
            <span aria-hidden>·</span>
            <span className="min-w-0 truncate">{task.lastNote.actor}</span>
            <span className="ms-auto shrink-0">{formatRelativeTimeLabel(task.lastNote.at)}</span>
          </div>
          <p className="mt-1 line-clamp-3 text-xs whitespace-pre-wrap text-foreground/80 wrap-anywhere">
            {task.lastNote.text}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** Notes clamped to a few lines with a "more" toggle when they overflow. */
function ClampedMarkdown({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !contentRef.current || expanded) return;
    const check = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    check();
    // The clamped box keeps its height as the text changes; observing the content catches that.
    const observer = new ResizeObserver(check);
    observer.observe(element);
    observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [expanded]);

  return (
    <div className="mt-1.5">
      <div
        ref={ref}
        className={cn(!expanded && "max-h-[4.5rem] overflow-hidden", !expanded && overflows && "mask-b-from-50%")}
      >
        <div ref={contentRef}>
          <Markdown size="xs">{text}</Markdown>
        </div>
      </div>
      {overflows || expanded ? (
        <span className="text-xs">
          <InlineButton tone="muted" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "less" : "more"}
          </InlineButton>
        </span>
      ) : null}
    </div>
  );
}
