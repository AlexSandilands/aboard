import { useState } from "react";

import { attachmentSrc } from "~/lib/api";
import { useDialogs } from "~/state/ui";
import { AttachmentPill } from "./AttachmentPill";

/**
 * A pasted image shown in place, at most the column's width, for Markdown at the document size (the task window).
 * A click opens the preview, as a pill or a thumbnail does; one that fails to load falls back to the pill.
 */
export function InlineAttachment({ id, name }: { id: string; name: string }) {
  const openPreview = useDialogs((s) => s.openImagePreview);
  const [broken, setBroken] = useState(false);
  if (broken) return <AttachmentPill id={id} name={name} />;
  return (
    <button
      type="button"
      title={`Preview ${name}`}
      onClick={() => openPreview({ id, filename: name })}
      className="my-1 block max-w-full cursor-zoom-in overflow-hidden rounded-lg border border-border bg-muted/40 outline-none hover:border-ring focus-visible:ring-2 focus-visible:ring-ring"
    >
      <img
        src={attachmentSrc(id)}
        alt={name}
        loading="lazy"
        className="block h-auto max-h-[36rem] max-w-full object-contain"
        onError={() => setBroken(true)}
      />
    </button>
  );
}
