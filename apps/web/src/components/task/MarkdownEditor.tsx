import { useRef, useState } from "react";

import { Textarea } from "~/components/ui/textarea";

const SAVE_HINT =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform) ? "⌘Enter to save · Esc to cancel" : "Ctrl+Enter to save · Esc to cancel";

/**
 * Markdown textarea that saves on blur or Ctrl/⌘+Enter and cancels on Esc.
 * `onSave` receives the trimmed text, or null when it was cleared.
 */
export function MarkdownEditor({
  value,
  onSave,
  onCancel,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onSave: (next: string | null) => void;
  onCancel: () => void;
  placeholder?: string;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState(value);
  const settled = useRef(false);
  const save = () => {
    if (settled.current) return;
    settled.current = true;
    const next = draft.trim();
    onSave(next.length > 0 ? next : null);
  };
  return (
    <div className="flex flex-col gap-1">
      <Textarea
        autoFocus
        aria-label={ariaLabel}
        size="sm"
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onFocus={(event) => {
          const end = event.currentTarget.value.length;
          event.currentTarget.setSelectionRange(end, end);
        }}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            settled.current = true;
            onCancel();
          }
        }}
      />
      <span className="self-end text-2xs text-muted-foreground">{SAVE_HINT}</span>
    </div>
  );
}
