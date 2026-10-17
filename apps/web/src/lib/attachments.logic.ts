import { ATTACHMENT_EXTENSIONS, ATTACHMENT_MAX_DIMENSION, MAX_ATTACHMENT_BYTES, formatBytes } from "@repo/contracts";

/** Images at or under this size, and within the dimension cap, are uploaded as they are. */
export const KEEP_BELOW_BYTES = 1024 * 1024;
export const REENCODE_TYPE = "image/webp";
export const REENCODE_QUALITY = 0.85;

/** `width` x `height` scaled down (never up) to at most `max` pixels on the long side. */
export function fitWithin(
  width: number,
  height: number,
  max = ATTACHMENT_MAX_DIMENSION,
): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const scale = max / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export type ImagePlan =
  | { kind: "keep" }
  | { kind: "reencode"; width: number; height: number; resized: boolean }
  | { kind: "reject"; reason: string };

const rejectOversize = (size: number): ImagePlan => ({
  kind: "reject",
  reason: `That image is ${formatBytes(size)}; the limit is ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
});

/**
 * What to do with an image before uploading it: GIFs (which may be animated) and small images go as they are,
 * larger or oversized ones are scaled down and re-encoded as WebP, and a type the board doesn't store is
 * converted the same way.
 */
export function planImage(image: { type: string; size: number; width: number; height: number }): ImagePlan {
  const supported = image.type in ATTACHMENT_EXTENSIONS;
  if (image.type === "image/gif")
    return image.size > MAX_ATTACHMENT_BYTES ? rejectOversize(image.size) : { kind: "keep" };
  const fitted = fitWithin(image.width, image.height);
  const resized = fitted.width !== image.width || fitted.height !== image.height;
  if (supported && !resized && image.size <= KEEP_BELOW_BYTES) return { kind: "keep" };
  return { kind: "reencode", ...fitted, resized };
}

/**
 * Which bytes to upload once re-encoding is done: the original when re-encoding didn't make a supported image
 * smaller (and it wasn't resized), else the new ones. Null when the result is still over the cap.
 */
export function pickUpload(args: {
  originalType: string;
  originalSize: number;
  encodedSize: number;
  resized: boolean;
}): { use: "original" | "encoded"; size: number } | { use: "none"; reason: string } {
  const keepOriginal =
    args.originalType in ATTACHMENT_EXTENSIONS && !args.resized && args.encodedSize >= args.originalSize;
  const size = keepOriginal ? args.originalSize : args.encodedSize;
  if (size > MAX_ATTACHMENT_BYTES) return { use: "none", reason: rejectOversizeReason(size) };
  return { use: keepOriginal ? "original" : "encoded", size };
}

const rejectOversizeReason = (size: number): string =>
  `That image is still ${formatBytes(size)} after shrinking; the limit is ${formatBytes(MAX_ATTACHMENT_BYTES)}.`;

/** `text` with `insert` put at the selection, spaced from the words around it; `caret` is where to put the cursor. */
export function insertAtSelection(
  text: string,
  start: number,
  end: number,
  insert: string,
): { text: string; caret: number } {
  const from = Math.min(Math.max(start, 0), text.length);
  const to = Math.min(Math.max(end, from), text.length);
  const before = text.slice(0, from);
  const after = text.slice(to);
  const lead = before === "" || /\s$/.test(before) ? "" : " ";
  const trail = after === "" || /^\s/.test(after) ? "" : " ";
  const inserted = `${lead}${insert}${trail}`;
  return { text: `${before}${inserted}${after}`, caret: before.length + lead.length + insert.length + trail.length };
}

/** The image files among a paste or drop's files. */
export const imageFiles = (files: Iterable<File>): File[] => [...files].filter((f) => f.type.startsWith("image/"));
