import type { HeadlessModel, TaskDetail } from "@repo/contracts";
import { useId, useState, type ReactNode } from "react";

import { autoReviewChoice, autoReviewOptions } from "~/components/review/review.logic";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { BlurInput } from "~/components/settings/BlurInput";
import { Switch } from "~/components/ui/switch";
import {
  headlessModelForOption,
  headlessModelItems,
  headlessModelOption,
  typedHeadlessModel,
} from "~/components/settings/headlessModel.logic";
import { useUpdateTask } from "~/state/mutations";
import { useSettings } from "~/state/queries";
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
                hint="The model that reviews this task: a tier or a model id. Inherit follows the project, then the board"
              >
                <ReviewModelPicker
                  value={task.reviewModel}
                  onChange={(model) => change({ setting: "reviewModel", model })}
                />
              </Row>
            ) : null}
            <Row label="Auto-merge" hint="Whether an agent may merge this task's pull request with merge_task_pr">
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

/** The task's reviewer model: inherit, a tier, or a typed model, which shows a field to name it. */
function ReviewModelPicker({
  value,
  onChange,
}: {
  value: HeadlessModel | null;
  onChange: (next: HeadlessModel | null) => void;
}) {
  // Custom was picked but nothing is typed yet, so there is nothing to save.
  const [typing, setTyping] = useState(false);
  const option = headlessModelOption(value, typing);
  const items = headlessModelItems(true, "Inherit");
  return (
    <>
      <ChoiceSelect
        ariaLabel="Reviewer model for this task"
        items={items}
        value={option}
        onChange={(next) => {
          if (next === option) return;
          const saved = headlessModelForOption(next, value);
          setTyping(saved === undefined);
          if (saved !== undefined) onChange(saved);
        }}
      />
      {option === "custom" ? (
        <BlurInput
          key={value && "model" in value ? value.model : "typing"}
          size="sm"
          className="w-28"
          aria-label="Reviewer model id"
          placeholder="claude-opus-5-5"
          value={value && "model" in value ? value.model : ""}
          onSave={(next) => {
            const typed = typedHeadlessModel(next);
            if (!typed) return;
            setTyping(false);
            onChange(typed);
          }}
        />
      ) : null}
    </>
  );
}
