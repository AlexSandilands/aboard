import { ATTACHMENT_EXTENSIONS } from "@repo/contracts";
import { ImagePlusIcon, XIcon } from "lucide-react";
import { type ClipboardEvent, type DragEvent, useCallback, useRef, useState } from "react";
import { Spinner } from "~/components/ui/spinner";
import { attachmentSrc, uploadAttachment } from "~/lib/api";
import { ImageRejected, prepareImage } from "~/lib/attachments";
import { imageFiles } from "~/lib/attachments.logic";
import { useDialogs } from "~/state/ui";
import { admitImages, launchImageIds, launchImagesBlocker, markUploaded, type LaunchImage } from "./launchImages.logic";
import { ComposerControl } from "./T3LaunchPickers";

/**
 * The images pasted, dropped or picked into a launch dialog's first message. Each is shrunk and uploaded at once with
 * no task (it waits in the pending folder, swept after a day if the dialog is closed); the launch sends `ids`, and the
 * server gives them to the task, or to T3 Code.
 */
export function useLaunchImages() {
  const [images, setImages] = useState<LaunchImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Read synchronously, so two pastes in a row can't both fit under the limit.
  const current = useRef<LaunchImage[]>([]);
  const update = useCallback((next: (images: LaunchImage[]) => LaunchImage[]) => {
    current.current = next(current.current);
    setImages(current.current);
  }, []);

  const add = useCallback(
    async (files: File[]) => {
      const { admitted, error: overLimit } = admitImages(current.current, files);
      setError(overLimit);
      const pending = admitted.map((file) => ({ file, key: crypto.randomUUID(), name: file.name || "image" }));
      update((list) => [...list, ...pending.map(({ key, name }) => ({ key, name, status: "uploading" as const }))]);
      for (const { file, key, name } of pending) {
        try {
          const attachment = await uploadAttachment(await prepareImage(file), name, null);
          update((list) => markUploaded(list, key, attachment.id));
        } catch (e) {
          update((list) => list.filter((image) => image.key !== key));
          setError(e instanceof ImageRejected || e instanceof Error ? e.message : "The image couldn't be added.");
        }
      }
    },
    [update],
  );

  const remove = useCallback((key: string) => update((list) => list.filter((image) => image.key !== key)), [update]);

  return {
    images,
    error,
    /** The uploaded images' ids, in order, for the launch. */
    ids: launchImageIds(images),
    /** Why the launch must wait, or null. */
    blocker: launchImagesBlocker(images),
    add,
    remove,
    /** Spread onto the first message's textarea. */
    handlers: {
      onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
        const files = imageFiles(event.clipboardData.files);
        if (files.length === 0) return;
        // A screenshot has no text to paste; if there is some too, the image still wins.
        event.preventDefault();
        void add(files);
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
        void add(files);
      },
    },
  };
}

export type LaunchImagesState = ReturnType<typeof useLaunchImages>;

/** The composer's "add an image" control: opens a file picker for images. */
export function AddImageControl({ state }: { state: LaunchImagesState }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <ComposerControl
        aria-label="Add images"
        title="Add images (or paste or drop them into the message)"
        onClick={() => input.current?.click()}
      >
        <ImagePlusIcon />
      </ComposerControl>
      <input
        ref={input}
        type="file"
        accept={Object.keys(ATTACHMENT_EXTENSIONS).join(",")}
        multiple
        hidden
        onChange={(event) => {
          void state.add(imageFiles(event.target.files ?? []));
          // So picking the same file again still fires a change.
          event.target.value = "";
        }}
      />
    </>
  );
}

/** Thumbnails of the dialog's images, each with a remove button; a click opens the preview. Nothing when empty. */
export function LaunchImageThumbs({ state }: { state: LaunchImagesState }) {
  const openPreview = useDialogs((s) => s.openImagePreview);
  if (state.images.length === 0 && !state.error) return null;
  return (
    <div className="px-3 pb-1">
      {state.images.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Images">
          {state.images.map((image) => (
            <li key={image.key} className="group relative">
              {image.status === "ready" ? (
                <button
                  type="button"
                  aria-label={`Preview ${image.name}`}
                  onClick={() => openPreview({ id: image.id, filename: image.name })}
                  className="block size-14 cursor-zoom-in overflow-hidden rounded-md border border-border bg-muted/40 outline-none hover:border-ring focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <img src={attachmentSrc(image.id)} alt="" className="size-full object-cover" />
                </button>
              ) : (
                <span
                  role="status"
                  aria-label={`Uploading ${image.name}`}
                  className="flex size-14 items-center justify-center rounded-md border border-border bg-muted/40"
                >
                  <Spinner className="size-4" />
                </span>
              )}
              <button
                type="button"
                aria-label={`Remove ${image.name}`}
                onClick={() => state.remove(image.key)}
                className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-border bg-popover text-muted-foreground opacity-0 shadow-sm outline-none transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
              >
                <XIcon className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {state.error ? <p className="mt-1 text-xs text-destructive-foreground">{state.error}</p> : null}
    </div>
  );
}
