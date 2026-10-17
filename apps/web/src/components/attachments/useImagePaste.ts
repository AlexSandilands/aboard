import { attachmentToken } from "@repo/contracts";
import { type ClipboardEvent, type DragEvent, useCallback, useRef, useState } from "react";

import { ImageRejected, prepareImage } from "~/lib/attachments";
import { imageFiles } from "~/lib/attachments.logic";
import { uploadAttachment } from "~/lib/api";

/**
 * Paste and drop of images into a textarea: each is shrunk (see prepareImage), uploaded, and its Markdown token
 * (`![name](attachment:id)`) put in the text where the cursor was. `insert` receives the token and the position and
 * returns where the cursor ends up, so the next image goes after it; `onSettled` runs when the last upload in flight is done, whether it worked or not.
 */
export function useImagePaste({
  taskId,
  insert,
  onSettled,
}: {
  /** The task the image belongs to; null in the new-task box, whose task isn't created yet. */
  taskId: string | null;
  insert: (token: string, at: { start: number; end: number }) => number;
  onSettled?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  const inFlight = useRef(0);

  const add = useCallback(
    async (files: File[], from: { start: number; end: number }) => {
      setError(null);
      let at = from;
      for (const file of files) {
        inFlight.current += 1;
        setUploading(inFlight.current);
        try {
          const blob = await prepareImage(file);
          const name = file.name || "image";
          const attachment = await uploadAttachment(blob, name, taskId);
          insert(attachmentToken(attachment.id, name.replace(/\.[a-z0-9]+$/i, "")), at);
        } catch (e) {
          setError(e instanceof ImageRejected || e instanceof Error ? e.message : "The image couldn't be added.");
        } finally {
          inFlight.current -= 1;
          setUploading(inFlight.current);
        }
      }
      if (inFlight.current === 0) onSettled?.();
    },
    [taskId, insert, onSettled],
  );

  const caret = (el: HTMLTextAreaElement) => ({ start: el.selectionStart, end: el.selectionEnd });

  return {
    error,
    uploading: uploading > 0,
    /** Spread onto the textarea. */
    handlers: {
      onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
        const files = imageFiles(event.clipboardData.files);
        if (files.length === 0) return;
        // Pasting a screenshot has no text to paste; if there is some too, the image still wins.
        event.preventDefault();
        void add(files, caret(event.currentTarget));
      },
      onDragOver(event: DragEvent<HTMLTextAreaElement>) {
        if ([...event.dataTransfer.items].some((item) => item.kind === "file" && item.type.startsWith("image/"))) {
          event.preventDefault();
        }
      },
      onDrop(event: DragEvent<HTMLTextAreaElement>) {
        const files = imageFiles(event.dataTransfer.files);
        if (files.length === 0) return;
        event.preventDefault();
        void add(files, caret(event.currentTarget));
      },
    },
  };
}
