import { useCallback, useRef, useState } from "react";

import { AttachmentThumbs } from "~/components/attachments/AttachmentThumbs";
import { MarkdownInput, useMarkdownInput } from "~/components/editor/MarkdownInput";

const SAVE_HINT =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform)
    ? "⌘Enter to save · Esc to cancel"
    : "Ctrl+Enter to save · Esc to cancel";

/**
 * Markdown editor (see MarkdownInput) that saves on blur or Ctrl/⌘+Enter and cancels on Esc.
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
  const markdown = useMarkdownInput({
    taskId,
    value: draft,
    onChange: setText,
    // Leaving the box mid-upload would save before the image's token is in the text; it saves once they land.
    onSettled: () => {
      if (blurredWhileUploading.current) save();
    },
  });
  return (
    <div className="flex flex-col gap-1">
      <MarkdownInput
        input={markdown.input}
        autoFocus
        ariaLabel={ariaLabel}
        placeholder={placeholder}
        onFocus={() => {
          blurredWhileUploading.current = false;
        }}
        onBlur={() => {
          if (markdown.uploading) blurredWhileUploading.current = true;
          else save();
        }}
        onKey={(key) => {
          if (key.key === "Enter" && (key.ctrlKey || key.metaKey)) {
            key.claim();
            if (markdown.uploading) blurredWhileUploading.current = true;
            else save();
          } else if (key.key === "Escape") {
            key.claim();
            settled.current = true;
            onCancel();
          }
        }}
      />
      {markdown.mode === "plain" ? <AttachmentThumbs text={draft} /> : null}
      <span className="flex items-baseline justify-between gap-2 text-2xs text-muted-foreground">
        <span
          className={markdown.error ? "text-destructive-foreground" : undefined}
          role={markdown.error ? "alert" : undefined}
        >
          {markdown.uploading ? "Uploading image…" : (markdown.error ?? "Paste or drop an image to attach it")}
        </span>
        <span className="shrink-0">{SAVE_HINT}</span>
      </span>
    </div>
  );
}
