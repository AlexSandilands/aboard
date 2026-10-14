import { nativeImage, type NativeImage } from "electron";

const SIZE = 32;
const BACKGROUND = [0xf1, 0x66, 0x63, 0xff]; // indigo, as BGRA
const FOREGROUND = [0xff, 0xff, 0xff, 0xff];
/** Three kanban columns, 4px wide from y=7, as [left x, bottom y] in a 32px grid. */
const COLUMNS: Array<[number, number]> = [
  [7, 25],
  [14, 19],
  [21, 13],
];

/**
 * Placeholder tray/window icon drawn in code until the real app icon lands (favicon idea), so the
 * shell ships no binary assets yet. A rounded square with three board columns.
 */
export function appIcon(): NativeImage {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const radius = 6;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = Math.max(radius - x, x - (SIZE - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (SIZE - 1 - radius), 0);
      if (dx * dx + dy * dy > radius * radius) continue;
      const inColumn = COLUMNS.some(([left, bottom]) => x >= left && x < left + 4 && y >= 7 && y < bottom);
      pixels.set(inColumn ? FOREGROUND : BACKGROUND, (y * SIZE + x) * 4);
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: SIZE, height: SIZE });
}
