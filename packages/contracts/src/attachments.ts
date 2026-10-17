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
