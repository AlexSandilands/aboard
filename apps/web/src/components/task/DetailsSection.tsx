import {
  describeRunModel,
  MODEL_TIERS,
  ModelTier,
  modelTierDescription,
  resolveTaskModel,
  type TaskDetail,
} from "@repo/contracts";
import { PencilIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { AttachmentThumbs } from "~/components/attachments/AttachmentThumbs";
import { Markdown } from "~/components/markdown/Markdown";
import { usePanelTaskLinks } from "./PanelTaskLinks";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { useUpdateTask } from "~/state/mutations";
import { useSettings } from "~/state/queries";
import { dueDateLabel, dueStateClassName, dueStateOf, dueStateText } from "./dueDate.logic";
import { MarkdownEditor } from "./MarkdownEditor";
import { TaskSection } from "./TaskSection";

/** The task's prose: what and why (description), then how (plan context). */
export function DetailsSection({ task }: { task: TaskDetail }) {
  const { mutate: updateTask } = useUpdateTask();
  return (
    <TaskSection title="Details">
      <div className="flex flex-col gap-3">
        <SuggestedModelField task={task} />
        {task.kind === "epic" ? null : <DueDateField task={task} />}
        <MarkdownField
          taskId={task.id}
          title="Description"
          value={task.description}
          placeholder="Add a description…"
          onSave={(description) => updateTask({ id: task.id, description })}
        />
        <MarkdownField
          taskId={task.id}
          title="Plan context"
          value={task.planContext}
          placeholder="Add plan context: goals, constraints, decisions…"
          onSave={(planContext) => updateTask({ id: task.id, planContext })}
        />
      </div>
    </TaskSection>
  );
}

const NO_TIER = "none";
const TIER_ITEMS = [{ value: NO_TIER, label: "None" }, ...MODEL_TIERS.map((t) => ({ value: t.value, label: t.label }))];

/**
 * The model tier the planner suggested for implementing the task, which the user can change or clear, and the custom
 * model one of its labels picks over the tier, when one does.
 */
function SuggestedModelField({ task }: { task: TaskDetail }) {
  const { mutate: updateTask } = useUpdateTask();
  const settings = useSettings().data;
  const modelTiers = settings?.modelTiers;
  const suggestion = task.suggestedModel;
  const mapped = suggestion && modelTiers ? modelTierDescription(modelTiers, suggestion.tier) : null;
  const picked = settings ? resolveTaskModel(task, settings) : null;
  const byLabel = picked?.source === "label" ? picked : null;
  return (
    <div className="px-1.5 pb-1">
      <div className="flex min-h-6 items-center gap-2">
        <h4 className="shrink-0 text-2xs text-muted-foreground/80 select-none">Suggested model</h4>
        <Select
          items={TIER_ITEMS}
          value={suggestion?.tier ?? NO_TIER}
          onValueChange={(value) => {
            const tier = ModelTier.safeParse(value);
            if ((tier.success ? tier.data : null) === (suggestion?.tier ?? null)) return;
            // A reason explains the planner's tier; it doesn't carry over to one the user picked.
            updateTask({ id: task.id, suggestedModel: tier.success ? { tier: tier.data } : null });
          }}
        >
          <SelectTrigger size="xs" className="w-auto min-w-28" aria-label="Suggested model tier">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {TIER_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {mapped ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground" title={mapped}>
            · {mapped}
          </span>
        ) : null}
      </div>
      {suggestion?.reason ? (
        <p className="mt-1 text-xs leading-snug text-muted-foreground/80">{suggestion.reason}</p>
      ) : null}
      {byLabel ? (
        <p className="mt-1 text-xs leading-snug text-muted-foreground">
          Runs on {describeRunModel({ ...byLabel, source: "tier" })}, picked by its label {byLabel.label}
          {suggestion ? " over the tier" : ""}. An automation set to a model of its own still uses that.
        </p>
      ) : null}
    </div>
  );
}

/** The optional due date: a native date input with a clear button. Reads amber when due today and red when overdue. */
function DueDateField({ task }: { task: TaskDetail }) {
  const { mutate: updateTask } = useUpdateTask();
  const { dueDate } = task;
  const state = dueDate ? dueStateOf(dueDate) : null;
  return (
    <div className="px-1.5 pb-1">
      <div className="flex min-h-6 items-center gap-2">
        <h4 className="shrink-0 text-2xs text-muted-foreground/80 select-none">Due date</h4>
        <Input
          size="sm"
          type="date"
          aria-label="Due date"
          min="0001-01-01"
          max="9999-12-31"
          className="w-auto"
          value={dueDate ?? ""}
          onChange={(event) => {
            // An emptied or half-typed input reports "", which is not a request to clear: that is the button.
            const next = event.currentTarget.value;
            if (next && next !== dueDate) updateTask({ id: task.id, dueDate: next });
          }}
        />
        {dueDate && state ? (
          <>
            <span className={`text-xs ${dueStateClassName(state)}`}>
              {state === "later" ? dueDateLabel(dueDate) : `${dueStateText(state)} · ${dueDateLabel(dueDate)}`}
            </span>
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label="Clear due date"
              onClick={() => updateTask({ id: task.id, dueDate: null })}
            >
              <XIcon />
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** A titled markdown block that renders until edited; saves on blur or Ctrl/⌘+Enter. */
function MarkdownField({
  taskId,
  title,
  value,
  placeholder,
  onSave,
}: {
  taskId: string;
  title: string;
  value: string | null;
  placeholder: string;
  onSave: (next: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const taskLinks = usePanelTaskLinks();
  const text = value?.trim() ? value : null;
  return (
    <div className="px-1.5">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h4 className="text-2xs text-muted-foreground/80 select-none">{title}</h4>
        {text && !editing ? (
          <Button
            variant="ghost-muted"
            size="xs"
            aria-label={`Edit ${title.toLowerCase()}`}
            onClick={() => setEditing(true)}
          >
            <PencilIcon />
            Edit
          </Button>
        ) : null}
      </div>
      {editing ? (
        <MarkdownEditor
          taskId={taskId}
          ariaLabel={title}
          value={text ?? ""}
          placeholder={placeholder}
          onSave={(next) => {
            setEditing(false);
            if (next !== text) onSave(next);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : text ? (
        <>
          <Markdown taskLinks={taskLinks}>{text}</Markdown>
          <AttachmentThumbs text={text} />
        </>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="w-full cursor-text rounded-md py-1 text-left text-[13px] text-muted-foreground/70 outline-none hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {placeholder}
        </button>
      )}
    </div>
  );
}
