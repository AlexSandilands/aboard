import { PROJECT_ICON_IMAGE_MAX_LENGTH, PROJECT_ICON_IMAGE_SIZE } from "@repo/contracts";
import { iconCanvasLayout, smallestDataUrl } from "./projectIconImage.logic";

async function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = src;
  try {
    await image.decode();
  } catch {
    throw new Error("That file couldn't be read as an image.");
  }
  return image;
}

/**
 * Resamples an image file (any format the browser can decode, SVG included) into a small raster
 * data URL that the project icon contract accepts.
 */
export async function imageFileToIconDataUrl(file: Blob): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const layout = iconCanvasLayout(image.naturalWidth, image.naturalHeight, PROJECT_ICON_IMAGE_SIZE);
    const canvas = document.createElement("canvas");
    canvas.width = layout.canvas;
    canvas.height = layout.canvas;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Your browser can't process images here.");
    context.imageSmoothingQuality = "high";
    context.drawImage(image, layout.x, layout.y, layout.width, layout.height);
    const dataUrl = smallestDataUrl(
      [canvas.toDataURL("image/png"), canvas.toDataURL("image/webp", 0.9), canvas.toDataURL("image/webp", 0.7)],
      PROJECT_ICON_IMAGE_MAX_LENGTH,
    );
    if (!dataUrl) throw new Error("That image is too detailed to use as an icon.");
    return dataUrl;
  } finally {
    URL.revokeObjectURL(url);
  }
}
