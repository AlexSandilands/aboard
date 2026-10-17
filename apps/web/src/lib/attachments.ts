import { attachmentExtension, MAX_ATTACHMENT_BYTES } from "@repo/contracts";
import { pickUpload, planImage, REENCODE_QUALITY, REENCODE_TYPE } from "./attachments.logic";

/** What went wrong with an image, in words for the person who pasted it. */
export class ImageRejected extends Error {}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * Shrinks an image in the browser before it is uploaded (see planImage): scaled to at most 2560px on the long side
 * and re-encoded as WebP when it is big, GIFs and small images untouched. Throws ImageRejected when it can't be
 * read or is still over the size cap.
 */
export async function prepareImage(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // A GIF the browser can't decode still uploads; the server checks it is what it says.
    if (file.type === "image/gif" && file.size <= MAX_ATTACHMENT_BYTES) return file;
    throw new ImageRejected("That image can't be read.");
  }
  try {
    const plan = planImage({ type: file.type, size: file.size, width: bitmap.width, height: bitmap.height });
    if (plan.kind === "reject") throw new ImageRejected(plan.reason);
    if (plan.kind === "keep") return file;
    const canvas = document.createElement("canvas");
    canvas.width = plan.width;
    canvas.height = plan.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, plan.width, plan.height);
    const encoded = await toBlob(canvas, REENCODE_TYPE, REENCODE_QUALITY);
    // A browser that can't encode WebP (Safari) hands back a PNG, which the board stores just as well.
    if (!encoded || attachmentExtension(encoded.type) === undefined)
      throw new ImageRejected("That image can't be converted.");
    const pick = pickUpload({
      originalType: file.type,
      originalSize: file.size,
      encodedSize: encoded.size,
      resized: plan.resized,
    });
    if (pick.use === "none") throw new ImageRejected(pick.reason);
    return pick.use === "original" ? file : encoded;
  } finally {
    bitmap.close();
  }
}
