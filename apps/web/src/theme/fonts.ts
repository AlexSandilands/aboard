// Copied from T3 Code (apps/web/src/appearanceFonts.ts), MIT — see NOTICE. Checks a typed font family against what
// the browser can actually draw, so a typo doesn't silently fall back to the default stack.
import { cssFontFamilies } from "./appearance.logic";

const FONT_PROBE_TEXT = "mmmmmmmmMMWli1O0@# fjord";
let fontProbeContext: CanvasRenderingContext2D | null | undefined;

function probeWidth(fontList: string): number | null {
  if (fontProbeContext === undefined) {
    fontProbeContext = document.createElement("canvas").getContext("2d");
  }
  if (fontProbeContext === null) return null;
  fontProbeContext.font = `16px ${fontList}`;
  return fontProbeContext.measureText(FONT_PROBE_TEXT).width;
}

/**
 * Canvas metric probing instead of document.fonts.check(): check() reports true
 * for families that are not installed at all (nothing needs loading), so it
 * cannot filter the dropdown.
 */
export function isFontFamilyAvailable(family: string): boolean {
  const families = cssFontFamilies(family);
  if (families === null) return false;
  if (/^(system-ui|sans-serif|serif|monospace|ui-monospace)$/i.test(families)) return true;
  try {
    for (const generic of ["monospace", "serif", "sans-serif"]) {
      const baseline = probeWidth(generic);
      const candidate = probeWidth(`${families}, ${generic}`);
      if (baseline === null || candidate === null) return false;
      if (candidate !== baseline) return true;
    }
    return false;
  } catch {
    return false;
  }
}

const MONOSPACE_PROBE_VARIANTS = ["normal 400", "normal 700", "italic 400", "italic 700"] as const;
const MONOSPACE_PROBE_GLYPHS = ["i", "M", "W", "0", "@", "#", ".", " "] as const;
const MONOSPACE_ADVANCE_TOLERANCE = 0.01;

function areFontAdvancesMonospace(advances: readonly number[]): boolean {
  const reference = advances[0];
  if (
    reference === undefined ||
    reference <= 0 ||
    advances.some((advance) => !Number.isFinite(advance) || advance <= 0)
  ) {
    return true;
  }
  return advances.every((advance) => Math.abs(advance - reference) < MONOSPACE_ADVANCE_TOLERANCE);
}

export function isMonospaceFamily(family: string): boolean {
  const families = cssFontFamilies(family);
  if (families === null) return true;
  try {
    if (fontProbeContext === undefined) {
      fontProbeContext = document.createElement("canvas").getContext("2d");
    }
    if (fontProbeContext === null) return true;
    const context = fontProbeContext;
    for (const variant of MONOSPACE_PROBE_VARIANTS) {
      context.font = `${variant} 32px ${families}, monospace`;
      const advances = MONOSPACE_PROBE_GLYPHS.map((glyph) => context.measureText(glyph).width);
      if (!areFontAdvancesMonospace(advances)) return false;
    }
    return true;
  } catch {
    return true;
  }
}
