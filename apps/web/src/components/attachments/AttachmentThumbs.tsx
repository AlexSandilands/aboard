import { attachmentIdsIn } from "@repo/contracts";
import { useState } from "react";

import { attachmentSrc } from "~/lib/api";
import { useDialogs } from "~/state/ui";

/** Thumbnails of the pasted images a text refers to; a click opens the preview. Ones that fail to load are left out. */
export function AttachmentThumbs({ text }: { text: string | null | undefined }) {
  const ids = attachmentIdsIn(text);
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const openPreview = useDialogs((s) => s.openImagePreview);
  const shown = ids.filter((id) => !broken.has(id));
  if (shown.length === 0) return null;
  return (
    <ul className="mt-1.5 flex flex-wrap gap-1.5">
      {shown.map((id) => (
        <li key={id}>
          <button
            type="button"
            aria-label="Preview image"
            // Keeps the focus where it is, so a click doesn't blur an editor above (which would save and close it).
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => openPreview({ id, filename: "image" })}
            className="block size-14 cursor-zoom-in overflow-hidden rounded-md border border-border bg-muted/40 outline-none hover:border-ring focus-visible:ring-2 focus-visible:ring-ring"
          >
            <img
              src={attachmentSrc(id)}
              alt=""
              loading="lazy"
              className="size-full object-cover"
              onError={() => setBroken((current) => new Set(current).add(id))}
            />
          </button>
        </li>
      ))}
    </ul>
  );
}
