export interface IconCanvasLayout {
  /** Edge of the square canvas. */
  readonly canvas: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Fits an image inside a square canvas without cropping, centred on a transparent background.
 * Never upscales: a 16px favicon stays 16px rather than being blurred to `maxSize`. Images with no
 * intrinsic size (some SVGs) fill a `maxSize` canvas.
 */
export function iconCanvasLayout(naturalWidth: number, naturalHeight: number, maxSize: number): IconCanvasLayout {
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    return { canvas: maxSize, x: 0, y: 0, width: maxSize, height: maxSize };
  }
  const canvas = Math.min(maxSize, Math.max(naturalWidth, naturalHeight));
  const scale = canvas / Math.max(naturalWidth, naturalHeight);
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  return { canvas, x: Math.floor((canvas - width) / 2), y: Math.floor((canvas - height) / 2), width, height };
}

/**
 * The shortest encoding that fits under `maxLength`, or null. Browsers that can't encode a format
 * fall back to PNG for `toDataURL`, so the candidates are filtered by their actual MIME prefix.
 */
export function smallestDataUrl(candidates: ReadonlyArray<string>, maxLength: number): string | null {
  let best: string | null = null;
  for (const candidate of candidates) {
    if (!/^data:image\/(png|webp);base64,/.test(candidate) || candidate.length > maxLength) continue;
    if (best === null || candidate.length < best.length) best = candidate;
  }
  return best;
}
