import type { TaskDetail } from "@repo/contracts";
import type { ReactNode } from "react";

import { autoReviewChoice, autoReviewOptions, autoReviewValue } from "~/components/review/review.logic";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { useUpdateTask } from "~/state/mutations";
import { useSettings } from "~/state/queries";
import { AUTO_MERGE_OPTIONS, AUTOPILOT_OPTIONS, autopilotChoice, autopilotValue } from "./autopilot.logic";
import { TaskSection } from "./TaskSection";

/**
 * The task's own automation settings in one place: whether Autopilot may start it, whether it is reviewed
 * locally and its PR merged without a person, and whether it jumps the queue. Only tasks have these, so the
 * panel leaves the section out for an epic.
 */
export function AutomationSection({ task }: { task: TaskDetail }) {
  const { mutate: updateTask } = useUpdateTask();
  const globalReview = useSettings().data?.autoReview ?? false;
  return (
    <TaskSection title="Automation">
      <div className="flex flex-col gap-1 px-1.5 pb-1">
        <Row label="Autopilot" hint="Whether Start planned tasks may start this task once it is planned">
          <ChoiceSelect
            ariaLabel="Autopilot for this task"
            items={AUTOPILOT_OPTIONS}
            value={autopilotChoice(task.autopilot)}
            onChange={(choice) => updateTask({ id: task.id, autopilot: autopilotValue(choice) })}
          />
        </Row>
        <Row label="Auto-review" hint="Open a local review round when the task moves to Review">
          <ChoiceSelect
            ariaLabel="Auto-review for this task"
            items={autoReviewOptions(globalReview)}
            value={autoReviewChoice(task.autoReview)}
            onChange={(choice) => updateTask({ id: task.id, autoReview: autoReviewValue(choice) })}
          />
        </Row>
        <Row label="Auto-merge" hint="Whether an agent may merge this task's pull request with merge_task_pr">
          <ChoiceSelect
            ariaLabel="Auto-merge for this task"
            items={AUTO_MERGE_OPTIONS}
            value={autopilotChoice(task.autoMerge)}
            onChange={(choice) => updateTask({ id: task.id, autoMerge: autopilotValue(choice) })}
          />
        </Row>
        <Row label="Priority" hint="Show the task in the priority lane above every project; Autopilot starts it first">
          <Switch
            size="sm"
            checked={task.priority}
            aria-label="Priority"
            // The actions menu doesn't offer priority on an archived task either.
            disabled={task.archivedAt !== null}
            onCheckedChange={(priority) => updateTask({ id: task.id, priority })}
          />
        </Row>
      </div>
    </TaskSection>
  );
}

function Row({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex min-h-6 items-center gap-2" title={hint}>
      <h4 className="w-20 shrink-0 text-2xs text-muted-foreground/80 select-none">{label}</h4>
      {children}
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
