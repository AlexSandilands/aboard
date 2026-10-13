import { useRef, useState } from "react";

import { Input, type InputProps } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";

/**
 * Single-line inline editor. Enter or blur commits a changed, non-empty value; Esc cancels.
 * The parent swaps it in for the display text while editing.
 */
export function InlineInput({
  value,
  onCommit,
  onCancel,
  size = "sm",
  placeholder,
  ariaLabel,
  className,
}: {
  value: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
  size?: InputProps["size"];
  placeholder?: string;
  ariaLabel: string;
  /** Layout only. */
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const settled = useRef(false);
  const commit = () => {
    if (settled.current) return;
    settled.current = true;
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
    else onCancel();
  };
  return (
    <Input
      autoFocus
      aria-label={ariaLabel}
      className={className}
      size={size}
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          settled.current = true;
          onCancel();
        }
      }}
    />
  );
}

/** Copies text and confirms with a toast. */
export function copyToClipboard(text: string, what: string) {
  void navigator.clipboard.writeText(text).then(
    () => toastManager.add({ type: "success", title: `Copied ${what}` }),
    () => toastManager.add({ type: "error", title: `Couldn't copy ${what}` }),
  );
}
