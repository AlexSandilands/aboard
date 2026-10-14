// Adapted from T3 Code (apps/web/src/lib/windowControlsOverlay.ts), MIT — see NOTICE.
// Trimmed to the `.wco` class; macOS traffic lights aren't supported yet.

interface WindowControlsOverlayLike {
  readonly visible: boolean;
  addEventListener(type: "geometrychange", listener: EventListener): void;
}

/**
 * Toggles `.wco` on <html> while the desktop shell paints native window controls over the page, so
 * CSS can shrink the top bars to the overlay and keep content clear of the buttons.
 */
export function syncDocumentWindowControlsOverlayClass(): void {
  const overlay = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayLike })
    .windowControlsOverlay;
  const update = () => document.documentElement.classList.toggle("wco", overlay?.visible === true);
  update();
  overlay?.addEventListener("geometrychange", update);
}
