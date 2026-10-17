import { ImageIcon } from "lucide-react";

import { useDialogs } from "~/state/ui";

/** A pasted image in the text: a pill with its name that opens the preview. */
export function AttachmentPill({ id, name }: { id: string; name: string }) {
  const openPreview = useDialogs((s) => s.openImagePreview);
  return (
    <button
      type="button"
      title={`Preview ${name}`}
      onClick={() => openPreview({ id, filename: name })}
      className="mx-0.5 inline-flex max-w-48 cursor-zoom-in items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-px align-baseline text-xs text-foreground/85 outline-none hover:border-ring focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ImageIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{name}</span>
    </button>
  );
}
