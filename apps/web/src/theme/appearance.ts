// Applies the Appearance prefs (contrast, glass, panel animations, fonts) to <html> and saves what it applied, so the
// index.html boot script can paint it before React loads. Pattern from T3 Code's routes/__root.tsx syncs, MIT — see
// NOTICE.
import { storageKey } from "@repo/contracts";
import { useAppearance } from "~/state/ui";
import { APPEARANCE_STYLE_PROPERTIES, appearancePaint, type AppearancePrefs } from "./appearance.logic";

const PAINT_KEY = storageKey("appearance-paint");
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function apply(prefs: AppearancePrefs) {
  const paint = appearancePaint(prefs, window.matchMedia(REDUCED_MOTION).matches);
  const root = document.documentElement;
  for (const property of APPEARANCE_STYLE_PROPERTIES) {
    const value = paint.style[property];
    if (value === undefined) root.style.removeProperty(property);
    else root.style.setProperty(property, value);
  }
  for (const [name, value] of Object.entries(paint.data)) root.setAttribute(`data-${name}`, value);
  try {
    window.localStorage.setItem(PAINT_KEY, JSON.stringify(paint));
  } catch {
    // Storage unavailable; the next load paints the defaults until the app applies the prefs.
  }
}

/** Called once at startup; keeps <html> in step with the prefs, other tabs and the reduced-motion setting. */
export function initAppearance() {
  apply(useAppearance.getState());
  useAppearance.subscribe((state, prev) => {
    if (
      state.contrast !== prev.contrast ||
      state.glassOpacity !== prev.glassOpacity ||
      state.panelAnimationMs !== prev.panelAnimationMs ||
      state.fontSans !== prev.fontSans ||
      state.fontMono !== prev.fontMono ||
      state.fontSize !== prev.fontSize
    ) {
      apply(state);
    }
  });
  window.matchMedia(REDUCED_MOTION).addEventListener("change", () => apply(useAppearance.getState()));
  // Another tab changed the prefs: zustand's persist doesn't listen for that itself.
  window.addEventListener("storage", (event) => {
    if (event.key === storageKey("appearance")) void useAppearance.persist.rehydrate();
  });
}
