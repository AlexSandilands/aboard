import { overrideValue, type ModelChoice, type TaskDetail } from "@repo/contracts";
import { useId, type ReactNode } from "react";

import { autoReviewChoice, autoReviewOptions } from "~/components/review/review.logic";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { TriangleAlertIcon } from "lucide-react";
import { inheritDetail, resolvesTo } from "~/components/models/choicePicker.logic";
import { ModelChoicePicker } from "~/components/models/ModelChoicePicker";
import { Switch } from "~/components/ui/switch";
import { useUpdateTask } from "~/state/mutations";
import { useBoard, useSettings } from "~/state/queries";
import { AUTO_MERGE_OPTIONS, AUTOPILOT_OPTIONS, autopilotChoice } from "./autopilot.logic";
import { automationUpdate, type AutomationChange } from "./automation.logic";
import { TaskSection } from "./TaskSection";

/**
 * The task's own automation settings in one place: whether Autopilot may start it, whether it is reviewed
 * locally and its PR merged without a person, and whether it jumps the queue. Only tasks have these, so the
 * panel leaves the section out for an epic. A manual task is for people, so it shows only Manual and Priority.
 */
export function AutomationSection({ task }: { task: TaskDetail }) {
  const { mutate: updateTask } = useUpdateTask();
  const settings = useSettings().data;
  const globalReview = settings?.autoReview ?? false;
  const change = (next: AutomationChange) => updateTask({ id: task.id, ...automationUpdate(next) });
  return (
    <TaskSection title="Automation">
      <div className="flex flex-col gap-1 px-1.5 pb-1">
        <Row label="Manual task" hint="A to-do for a person: it needs no plan, and agents and Autopilot leave it alone">
          <Switch
            size="sm"
            checked={task.manual}
            aria-label="Manual task"
            onCheckedChange={(on) => change({ setting: "manual", on })}
          />
        </Row>
        {!task.manual && (
          <>
            <Row label="Autopilot" hint="Whether Start planned tasks may start this task once it is planned">
              <ChoiceSelect
                ariaLabel="Autopilot for this task"
                items={AUTOPILOT_OPTIONS}
                value={autopilotChoice(task.autopilot)}
                onChange={(choice) => change({ setting: "autopilot", choice })}
              />
            </Row>
            <Row label="Auto-review" hint="Open a local review round when the task moves to Review">
              <ChoiceSelect
                ariaLabel="Auto-review for this task"
                items={autoReviewOptions(globalReview)}
                value={autoReviewChoice(task.autoReview)}
                onChange={(choice) => change({ setting: "autoReview", choice })}
              />
            </Row>
            {(task.autoReview ?? globalReview) ? (
              <Row
                label="Reviewer"
                hint="The model that reviews this task: a tier, a custom model or a provider's model. Inherit follows the project, then the board"
              >
                <ReviewModelPicker task={task} onChange={(model) => change({ setting: "reviewModel", model })} />
              </Row>
            ) : null}
            <Row
              label="Auto-merge"
              hint="Whether this task's pull request may merge into main without you: by Autopilot's Merge ready PRs (with Into main on) or an agent's merge_task_pr"
            >
              <ChoiceSelect
                ariaLabel="Auto-merge for this task"
                items={AUTO_MERGE_OPTIONS}
                value={autopilotChoice(task.autoMerge)}
                onChange={(choice) => change({ setting: "autoMerge", choice })}
              />
            </Row>
          </>
        )}
        <Row label="Priority" hint="Show the task in the priority lane above every project; Autopilot starts it first">
          <Switch
            size="sm"
            checked={task.priority}
            aria-label="Priority"
            // The actions menu doesn't offer priority on an archived task either.
            disabled={task.archivedAt !== null}
            onCheckedChange={(on) => change({ setting: "priority", on })}
          />
        </Row>
      </div>
    </TaskSection>
  );
}

function Row({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  const hintId = useId();
  return (
    // The hint is also the mouse tooltip; describing the group makes it reach keyboard and screen-reader users.
    <div
      role="group"
      aria-label={label}
      aria-describedby={hintId}
      className="flex min-h-6 items-center gap-2"
      title={hint}
    >
      <h4 className="w-20 shrink-0 text-2xs text-muted-foreground/80 select-none">{label}</h4>
      {children}
      <span id={hintId} className="sr-only">
        {hint}
      </span>
    </div>
  );
}

function ChoiceSelect<T extends string>({
  ariaLabel,
  items,
  value,
  onChange,
}: {
  ariaLabel: string;
  items: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
    >
      <SelectTrigger size="xs" className="w-auto min-w-28" aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * The task's reviewer model, for the reviewer subagent and the board reviewer. Inherit follows the project's, then the
 * board's, and says what that comes down to for this task.
 */
function ReviewModelPicker({ task, onChange }: { task: TaskDetail; onChange: (next: ModelChoice | null) => void }) {
  const settings = useSettings().data;
  const project = useBoard().data?.projects.find((p) => p.id === task.projectId);
  if (!settings) return null;
  const ctx = { task, projectOverride: project?.reviewModel ?? null, taskOverride: task.reviewModel };
  // The override drives the board reviewer too, which needs more of its provider than the subagent does.
  const board = resolvesTo("boardReviewer", ctx, settings);
  return (
    <>
      <ModelChoicePicker
        op="reviewer"
        value={task.reviewModel}
        inherit={{ label: "Inherit", detail: inheritDetail("reviewer", { ...ctx, taskOverride: null }, settings) }}
        ariaLabel="Reviewer model for this task"
        size="xs"
        className="min-w-28"
        onChange={(next) => onChange(overrideValue(next))}
      />
      {board.ok ? null : (
        <span title={`Board reviewer: ${board.text}`} className="flex text-warning">
          <TriangleAlertIcon aria-hidden className="size-3.5" />
          <span className="sr-only">Board reviewer: {board.text}</span>
        </span>
      )}
    </>
  );
}
