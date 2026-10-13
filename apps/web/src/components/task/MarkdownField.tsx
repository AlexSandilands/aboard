import { PencilIcon } from "lucide-react";
import { useState } from "react";

import { Markdown } from "~/components/markdown/Markdown";
import { Button } from "~/components/ui/button";
import { MarkdownEditor } from "./MarkdownEditor";
import { TaskSection } from "./TaskSection";

/** A markdown section that renders until edited; saves on blur or Ctrl/⌘+Enter. */
export function MarkdownField({
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
    <TaskSection
      title={title}
      actions={
        text && !editing ? (
          <Button variant="ghost-muted" size="xs" onClick={() => setEditing(true)}>
            <PencilIcon />
            Edit
          </Button>
        ) : null
      }
    >
      <div className="px-1.5">
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
    </TaskSection>
  );
}
