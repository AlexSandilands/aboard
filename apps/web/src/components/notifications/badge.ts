import { badgeText, type DesktopBridge } from "@repo/contracts";
import { desktopBridge } from "~/lib/desktopBridge";
import { unreadDescription } from "./notifications.logic";

const BADGE_RED = "#ef4444";

/** Draws the red count circle with `text` centred in it, filling a square canvas. */
function drawBadge(
  ctx: CanvasRenderingContext2D,
  size: number,
  text: string,
  center: { x: number; y: number },
  radius: number,
) {
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = BADGE_RED;
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // "9+" has two glyphs to fit in the same circle.
  const fontSize = text.length > 1 ? radius * 1.1 : radius * 1.4;
  ctx.font = `700 ${fontSize}px system-ui, "Segoe UI", sans-serif`;
  // Centring on the middle baseline sits a touch high for digits.
  ctx.fillText(text, center.x, center.y + size * 0.01);
}

/** The Windows taskbar overlay: a red circle with the count, as a PNG data URL. Null when there is nothing to show. */
export function renderOverlayIcon(count: number): string | null {
  const text = badgeText(count);
  if (!text) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  drawBadge(ctx, 32, text, { x: 16, y: 16 }, 15);
  return canvas.toDataURL("image/png");
}

let originalFavicon: string | null = null;
let baseImage: Promise<HTMLImageElement | null> | null = null;
let faviconRun = 0;

const faviconLink = () => document.querySelector<HTMLLinkElement>('link[rel~="icon"]');

const loadBase = (href: string): Promise<HTMLImageElement | null> =>
  (baseImage ??= new Promise((resolve) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => resolve(null), { once: true });
    image.src = href;
  }));

/** The browser tab's favicon with the unread count drawn on it; the original again at zero. */
async function showFaviconCount(count: number): Promise<void> {
  const link = faviconLink();
  if (!link) return;
  originalFavicon ??= link.href;
  const run = (faviconRun += 1);
  const text = badgeText(count);
  if (!text) {
    link.href = originalFavicon;
    return;
  }
  const base = await loadBase(originalFavicon);
  // A newer count arrived while the base icon loaded.
  if (run !== faviconRun) return;
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  if (base) ctx.drawImage(base, 0, 0, 64, 64);
  drawBadge(ctx, 64, text, { x: 44, y: 20 }, 20);
  link.type = "image/png";
  link.href = canvas.toDataURL("image/png");
}

/**
 * Shows the unread count outside the page: on the taskbar and tray in the desktop app, on the tab's favicon in a
 * browser (the desktop window's own favicon isn't visible).
 */
export function showUnreadCount(count: number, bridge: DesktopBridge | null = desktopBridge()): void {
  if (bridge) {
    bridge.setBadge({ count, description: unreadDescription(count), overlay: renderOverlayIcon(count) });
    return;
  }
  void showFaviconCount(count);
}
