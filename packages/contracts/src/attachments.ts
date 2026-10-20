import { z } from "zod";

// Images pasted into a task's text. The text holds a token, `![image](attachment:<id>)`; the file lives on the
// board's disk and the server serves it at `/api/attachments/<id>` (see docs/features/attachments.md).

/** Accepted image types and the file extension each is stored with. */
export const ATTACHMENT_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** The browser scales larger images down to this many pixels on the long side before uploading. */
export const ATTACHMENT_MAX_DIMENSION = 2560;

export const TaskAttachment = z.object({
  id: z.string(),
  /** The task it belongs to; null while it was uploaded for a task that isn't created yet. */
  taskId: z.string().nullable(),
  filename: z.string(),
  mime: z.string(),
  size: z.number().int(),
  createdAt: z.string(),
});
export type TaskAttachment = z.infer<typeof TaskAttachment>;

const TOKEN = /!\[([^\]\n]*)\]\(attachment:([0-9a-f-]{36})\)/g;

/** The Markdown an attachment is written into the text as. */
export const attachmentToken = (id: string, alt = "image"): string =>
  `![${alt.replace(/[[\]\n]/g, " ").trim() || "image"}](attachment:${id})`;

/** The ids of the attachments a text refers to, in order of first appearance. */
export function attachmentIdsIn(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...new Set([...text.matchAll(TOKEN)].map((m) => m[2]!))];
}

/** Where the server serves an attachment. */
export const attachmentUrl = (id: string): string => `/api/attachments/${id}`;

/** The `attachment:<id>` URL of an image in Markdown, or null for any other URL. */
export function attachmentIdOf(url: string | undefined): string | null {
  const match = url ? /^attachment:([0-9a-f-]{36})$/.exec(url) : null;
  return match ? match[1]! : null;
}

/** "340 KB", "1.2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Whether `value` can be a task or attachment id (a UUID). They become path segments, and a backup is untrusted. */
export const isAttachmentPathId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f-]{36}$/.test(value);

/** The file extension an image of this type is stored with; undefined for any other type. */
export const attachmentExtension = (mime: string): string | undefined =>
  Object.hasOwn(ATTACHMENT_EXTENSIONS, mime) ? ATTACHMENT_EXTENSIONS[mime] : undefined;

/** The most images one hand-off launch (a T3 thread or a CLI session) takes. */
export const MAX_LAUNCH_IMAGES = 10;

/** The images pasted into a launch dialog, uploaded beforehand (`POST /api/attachments`), in order. */
export const LaunchAttachmentIds = z.array(z.uuid()).max(MAX_LAUNCH_IMAGES);

/**
 * The lines that point an agent at images saved on disk, in T3 Code's own wording, for a CLI that can't take an image
 * on its command line. Empty for no images.
 */
export const attachedImagesLines = (images: ReadonlyArray<{ filename: string; path: string }>): string =>
  images.map((image) => `[Attached image "${image.filename}" is saved at: ${image.path}]`).join("\n\n");

/** The prompt with the pointers to its images after it, as T3 Code adds them. */
export const withAttachedImages = (
  prompt: string,
  images: ReadonlyArray<{ filename: string; path: string }>,
): string => (images.length === 0 ? prompt : `${prompt}\n\n${attachedImagesLines(images)}`);
