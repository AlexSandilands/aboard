import { useCallback, useRef, useState } from "react";

import { AttachmentThumbs } from "~/components/attachments/AttachmentThumbs";
import { useImagePaste } from "~/components/attachments/useImagePaste";
import { Textarea } from "~/components/ui/textarea";
import { insertAtSelection } from "~/lib/attachments.logic";

const SAVE_HINT =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform)
    ? "⌘Enter to save · Esc to cancel"
    : "Ctrl+Enter to save · Esc to cancel";

/**
 * Markdown textarea that saves on blur or Ctrl/⌘+Enter and cancels on Esc.
 * `onSave` receives the trimmed text, or null when it was cleared.
 * Images pasted or dropped into it are attached to `taskId` and written into the text as a token.
 */
export function MarkdownEditor({
  taskId,
  value,
  onSave,
  onCancel,
  placeholder,
  ariaLabel,
}: {
  taskId: string;
  value: string;
  onSave: (next: string | null) => void;
  onCancel: () => void;
  placeholder?: string;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState(value);
  // The draft as of now, for the async inserts and saves that would otherwise see an older render's.
  const draftRef = useRef(value);
  const settled = useRef(false);
  const blurredWhileUploading = useRef(false);
  const setText = useCallback((next: string) => {
    draftRef.current = next;
    setDraft(next);
  }, []);
  const save = useCallback(() => {
    if (settled.current) return;
    settled.current = true;
    const next = draftRef.current.trim();
    onSave(next.length > 0 ? next : null);
  }, [onSave]);
  const paste = useImagePaste({
    taskId,
    insert: (token, at) => {
      const { text, caret } = insertAtSelection(draftRef.current, at.start, at.end, token);
      setText(text);
      return caret;
    },
    // Leaving the box mid-upload would save before the image's token is in the text; it saves once they land.
    onSettled: () => {
      if (blurredWhileUploading.current) save();
    },
  });
  return (
    <div className="flex flex-col gap-1">
      <Textarea
        autoFocus
        aria-label={ariaLabel}
        size="sm"
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setText(event.currentTarget.value)}
        onFocus={(event) => {
          const end = event.currentTarget.value.length;
          event.currentTarget.setSelectionRange(end, end);
        }}
        onBlur={() => {
          if (paste.uploading) blurredWhileUploading.current = true;
          else save();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            if (paste.uploading) blurredWhileUploading.current = true;
            else save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            settled.current = true;
            onCancel();
          }
        }}
        {...paste.handlers}
      />
      <AttachmentThumbs text={draft} />
      <span className="flex items-baseline justify-between gap-2 text-2xs text-muted-foreground">
        <span
          className={paste.error ? "text-destructive-foreground" : undefined}
          role={paste.error ? "alert" : undefined}
        >
          {paste.uploading ? "Uploading image…" : (paste.error ?? "Paste or drop an image to attach it")}
        </span>
        <span className="shrink-0">{SAVE_HINT}</span>
      </span>
    </div>
  );
}
