import type { TaskDetail } from "@repo/contracts";
import { PencilIcon } from "lucide-react";
import { useState } from "react";

import { Markdown } from "~/components/markdown/Markdown";
import { Button } from "~/components/ui/button";
import { useUpdateTask } from "~/state/mutations";
import { MarkdownEditor } from "./MarkdownEditor";
import { TaskSection } from "./TaskSection";

/** The task's prose: what and why (description), then how (plan context). */
export function DetailsSection({ task }: { task: TaskDetail }) {
  const { mutate: updateTask } = useUpdateTask();
  return (
    <TaskSection title="Details">
      <div className="flex flex-col gap-3">
        <MarkdownField
          title="Description"
          value={task.description}
          placeholder="Add a description…"
          onSave={(description) => updateTask({ id: task.id, description })}
        />
        <MarkdownField
          title="Plan context"
          value={task.planContext}
          placeholder="Add plan context: goals, constraints, decisions…"
          onSave={(planContext) => updateTask({ id: task.id, planContext })}
        />
      </div>
    </TaskSection>
  );
}

/** A titled markdown block that renders until edited; saves on blur or Ctrl/⌘+Enter. */
function MarkdownField({
  title,
  value,
  placeholder,
  onSave,
}: {
  title: string;
  value: string | null;
  placeholder: string;
  onSave: (next: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
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
        <Markdown>{text}</Markdown>
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
