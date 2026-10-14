import { PROJECT_ICON_IMAGE_MAX_LENGTH, PROJECT_ICON_IMAGE_SIZE } from "@repo/contracts";
import { iconCanvasLayout, smallestDataUrl } from "./projectIconImage.logic";

/** Decoding happens on the main thread, so very large files could freeze the tab first. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** A failure whose message is written for the user, as opposed to a raw browser exception. */
export class IconImageError extends Error {}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = src;
  try {
    await image.decode();
  } catch {
    throw new IconImageError("That file couldn't be read as an image.");
  }
  return image;
}

/**
 * Resamples an image file (any format the browser can decode, SVG included) into a small raster
 * data URL that the project icon contract accepts.
 */
export async function imageFileToIconDataUrl(file: Blob): Promise<string> {
  // Some OSes report no MIME type for formats the browser can still decode (e.g. .ico), so an
  // empty type is left to decode() to judge.
  if (file.type && !file.type.startsWith("image/")) throw new IconImageError("Choose an image file.");
  if (file.size > MAX_FILE_BYTES) throw new IconImageError("That image is too large. Choose one under 20 MB.");
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const layout = iconCanvasLayout(image.naturalWidth, image.naturalHeight, PROJECT_ICON_IMAGE_SIZE);
    let candidates: string[];
    try {
      const canvas = document.createElement("canvas");
      canvas.width = layout.canvas;
      canvas.height = layout.canvas;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("No 2D canvas context");
      context.imageSmoothingQuality = "high";
      context.drawImage(image, layout.x, layout.y, layout.width, layout.height);
      candidates = [
        canvas.toDataURL("image/png"),
        canvas.toDataURL("image/webp", 0.9),
        canvas.toDataURL("image/webp", 0.7),
      ];
    } catch {
      // e.g. Firefox throws NS_ERROR_NOT_AVAILABLE drawing an SVG with no intrinsic size.
      throw new IconImageError("That image couldn't be converted. Try a PNG or JPEG.");
    }
    const dataUrl = smallestDataUrl(candidates, PROJECT_ICON_IMAGE_MAX_LENGTH);
    if (!dataUrl) throw new IconImageError("That image is too detailed to use as an icon.");
    return dataUrl;
  } finally {
    URL.revokeObjectURL(url);
  }
}
