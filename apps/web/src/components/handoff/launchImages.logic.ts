import { MAX_LAUNCH_IMAGES } from "@repo/contracts";

// The images pasted into a hand-off launch dialog (T3 Code or a CLI session). Each is uploaded as it is added, with no
// task, and the launch sends their ids; see docs/features/attachments.md.

/** An image in the dialog: uploading, then uploaded with its attachment id. */
export type LaunchImage =
  | { key: string; name: string; status: "uploading" }
  | { key: string; name: string; status: "ready"; id: string };

/** What adding `adding` images to `images` does: the ones that fit under the limit, and why the rest were left out. */
export function admitImages<T>(
  images: readonly LaunchImage[],
  adding: readonly T[],
): { admitted: T[]; error: string | null } {
  const room = Math.max(0, MAX_LAUNCH_IMAGES - images.length);
  return {
    admitted: adding.slice(0, room),
    error: adding.length > room ? `A launch takes up to ${MAX_LAUNCH_IMAGES} images.` : null,
  };
}

/** The uploaded images' ids, in the order they were added. */
export const launchImageIds = (images: readonly LaunchImage[]): string[] =>
  images.flatMap((image) => (image.status === "ready" ? [image.id] : []));

/** Why the dialog can't start yet because of its images, or null. */
export const launchImagesBlocker = (images: readonly LaunchImage[]): string | null =>
  images.some((image) => image.status === "uploading") ? "Wait for the images to upload" : null;

/** The image with `key` uploaded as `id`; the others as they were. */
export const markUploaded = (images: readonly LaunchImage[], key: string, id: string): LaunchImage[] =>
  images.map((image) => (image.key === key ? { key, name: image.name, status: "ready", id } : image));
