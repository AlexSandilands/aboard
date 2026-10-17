import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from "react";

import { useImagePaste } from "~/components/attachments/useImagePaste";
import { Textarea } from "~/components/ui/textarea";
import { insertAtSelection, replaceFirst } from "~/lib/attachments.logic";
import { cn } from "~/lib/utils";
import { useRichEditor } from "./loadRichEditor";
import type { RichMarkdownEditorHandle } from "./RichMarkdownEditor";

/** "loading" until the rich editor's code is in (see loadRichEditor). */
export type MarkdownInputMode = "rich" | "plain" | "loading";

/** A key pressed in the input, the same from either editor. */
export interface MarkdownKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /** Takes the key: nothing else (the editor, a dialog around it) acts on it. */
  claim: () => void;
}

/**
 * The state behind a `MarkdownInput`: which editor it shows, and the images being pasted into it (uploaded
 * to `taskId`, or to no task yet in the new-task box). The mode is picked from the text when it arrives
 * from outside, never while typing, so the editor doesn't swap under the cursor.
 */
export function useMarkdownInput({
  taskId,
  value,
  onChange,
  onSettled,
}: {
  taskId: string | null;
  value: string;
  onChange: (next: string) => void;
  /** Runs when the last upload in flight is done, whether it worked or not. */
  onSettled?: () => void;
}) {
  const rich = useRichEditor();
  // Text the rich editor would change or show wrongly is edited as it is, in a textarea.
  const modeFor = (text: string): MarkdownInputMode =>
    rich ? (rich.fitsRichEditor(text) ? "rich" : "plain") : "loading";
  // The last text this input sent out; a value that differs came from outside.
  const [sent, setSent] = useState(value);
  const [mode, setMode] = useState<MarkdownInputMode>(() => modeFor(value));
  if (value !== sent) {
    setSent(value);
    setMode(modeFor(value));
  } else if (mode === "loading" && rich) {
    setMode(modeFor(value));
  }
  // The text as of now, for the uploads that land after the next keystroke.
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  }, [value]);
  const modeNow = useRef(mode);
  useEffect(() => {
    modeNow.current = mode;
  }, [mode]);
  const editor = useRef<RichMarkdownEditorHandle>(null);

  const emit = useCallback(
    (next: string) => {
      latest.current = next;
      setSent(next);
      onChange(next);
    },
    [onChange],
  );
  const paste = useImagePaste({
    taskId,
    insert: (placeholder, at) => {
      if (modeNow.current === "rich") {
        editor.current?.insertUpload(placeholder);
        return 0;
      }
      const { text, caret } = insertAtSelection(latest.current, at.start, at.end, placeholder);
      emit(text);
      return caret;
    },
    replace: (placeholder, replacement) => {
      editor.current?.resolveUpload(placeholder, replacement);
      if (latest.current.includes(placeholder)) emit(replaceFirst(latest.current, placeholder, replacement));
    },
    onSettled,
  });

  return {
    mode,
    uploading: paste.uploading,
    error: paste.error,
    /** Spread onto `MarkdownInput`. */
    input: { mode, value, emit, editor, paste },
  };
}

type MarkdownInputState = ReturnType<typeof useMarkdownInput>["input"];

const isComposing = (event: ReactKeyboardEvent) => event.nativeEvent.isComposing || event.keyCode === 229;

/**
 * A Markdown text box: rich text (see RichMarkdownEditor) when the text allows it, else a plain textarea
 * that says so. Images pasted or dropped into either are uploaded and written into the text as tokens.
 */
export function MarkdownInput({
  input,
  ariaLabel,
  placeholder,
  autoFocus = false,
  onKey,
  onFocus,
  onBlur,
  className,
}: {
  input: MarkdownInputState;
  ariaLabel: string;
  placeholder?: string;
  autoFocus?: boolean;
  onKey?: (key: MarkdownKey) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  className?: string;
}) {
  const { mode, value, emit, editor, paste } = input;
  const rich = useRichEditor();
  const frame = cn(
    "relative w-full rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow focus-within:border-ring focus-within:shadow-none focus-within:ring-[3px] focus-within:ring-inset sm:text-sm dark:bg-input/32",
    className,
  );
  // Only for the moment the editor's code takes to arrive, usually none: it is loaded once the app is idle.
  if (mode === "loading" || (mode === "rich" && !rich)) return <div className={cn(frame, "min-h-16.5")} />;
  if (mode === "rich" && rich) {
    const { RichMarkdownEditor } = rich;
    return (
      <div className={frame}>
        <RichMarkdownEditor
          ref={editor}
          value={value}
          onChange={emit}
          onImages={(files) => void paste.add(files, { start: 0, end: 0 })}
          onKeyDown={(event) => {
            let claimed = false;
            onKey?.({
              key: event.key,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              shiftKey: event.shiftKey,
              claim: () => {
                claimed = true;
                event.preventDefault();
                event.stopPropagation();
              },
            });
            return claimed;
          }}
          onFocus={onFocus}
          onBlur={onBlur}
          ariaLabel={ariaLabel}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className="max-h-64 overflow-y-auto"
        />
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      <Textarea
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        size="sm"
        value={value}
        placeholder={placeholder}
        onChange={(event) => emit(event.currentTarget.value)}
        onFocus={(event) => {
          if (autoFocus) {
            const end = event.currentTarget.value.length;
            event.currentTarget.setSelectionRange(end, end);
          }
          onFocus?.();
        }}
        onBlur={onBlur}
        onKeyDown={(event) => {
          if (isComposing(event)) return;
          onKey?.({
            key: event.key,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
            claim: () => {
              // Stops Base UI from also handling the key (the palette clicking its highlighted row on Enter).
              (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
              event.preventDefault();
              event.stopPropagation();
            },
          });
        }}
        {...paste.handlers}
      />
      {value.trim() ? (
        <span className="px-1 text-2xs text-muted-foreground">
          Editing as plain Markdown: this text has formatting the editor can't show.
        </span>
      ) : null}
    </div>
  );
}
