// Copied from T3 Code (packages/shared/src/themePreview.ts), MIT — see NOTICE: how a theme card's orbs are drawn.
import type { ThemeAppearance } from "./palettes";

export type ThemePreviewColors = Readonly<{
  canvas: string;
  accent: string;
  messageAction: string;
}>;

export const STANDARD_THEME_PREVIEW_COLORS: Readonly<Record<ThemeAppearance, ThemePreviewColors>> = {
  light: {
    canvas: "#fcfcfc",
    accent: "#f4f4f5",
    messageAction: "#4f46e5",
  },
  dark: {
    canvas: "#0a0a0a",
    accent: "#1c1c1f",
    messageAction: "#8b9cff",
  },
};

export type ThemePreviewRenderSpec = Readonly<{
  baseTarget: string;
  baseWeight: number;
  accent: Readonly<{
    center: readonly [x: number, y: number];
    middleOffset: number;
    middleOpacity: number;
    endOffset: number;
  }>;
  action: Readonly<{
    center: readonly [x: number, y: number];
    startOpacity: number;
    endOffset: number;
  }>;
  scale: number;
  blurAt56Px: number;
}>;

export const THEME_PREVIEW_RENDER_SPECS: Readonly<Record<ThemeAppearance, ThemePreviewRenderSpec>> = {
  light: {
    baseTarget: "#ffffff",
    baseWeight: 0.8,
    accent: {
      center: [0.72, 0.22],
      middleOffset: 0.28,
      middleOpacity: 0.72,
      endOffset: 0.58,
    },
    action: {
      center: [0.18, 0.82],
      startOpacity: 0.45,
      endOffset: 0.55,
    },
    scale: 1.1,
    blurAt56Px: 3,
  },
  dark: {
    baseTarget: "#09090b",
    baseWeight: 0.8,
    accent: {
      center: [0.28, 0.78],
      middleOffset: 0.28,
      middleOpacity: 0.62,
      endOffset: 0.58,
    },
    action: {
      center: [0.82, 0.18],
      startOpacity: 0.45,
      endOffset: 0.55,
    },
    scale: 1.1,
    blurAt56Px: 3,
  },
};
