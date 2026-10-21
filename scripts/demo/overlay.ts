/// <reference lib="dom" />
import type { Locator, Page } from "playwright";

export interface EndCard {
  name: string;
  tagline: string;
  detail: string;
  /** URL of the logo. */
  icon: string;
}

/** What the overlay adds to the page, as `window.demoOverlay`. */
interface DemoOverlay {
  move(x: number, y: number, ms: number): Promise<void>;
  ripple(): void;
  keys(label: string): void;
  endCard(card: EndCard): Promise<void>;
}

declare global {
  interface Window {
    demoOverlay: DemoOverlay;
  }
}

/**
 * Runs in the page (serialised by addInitScript, so it can't use anything from this module). The cursor, click
 * ripple, key pills and end card are added to <html>, outside the app's <body>, so React never touches them.
 */
function installInPage(): void {
  const ease = "cubic-bezier(0.65, 0, 0.35, 1)";
  const layer = (css: string) => {
    const el = document.createElement("div");
    el.style.cssText = `position:fixed;pointer-events:none;z-index:2147483647;${css}`;
    return el;
  };
  let cursor: HTMLDivElement | null = null;
  let pos = { x: 1500, y: 900 };
  const mount = () => {
    if (cursor) return cursor;
    cursor = layer(`left:0;top:0;width:26px;height:26px;transform:translate(${pos.x}px,${pos.y}px);`);
    // A macOS-style arrow: white with a dark outline, so it reads on both themes.
    cursor.innerHTML = `<svg width="26" height="26" viewBox="0 0 26 26" style="filter:drop-shadow(0 2px 3px rgb(0 0 0 / .45))">
      <path d="M4 2.5v18.2l4.6-4.4 3 7 3.2-1.4-3-6.9h6.5z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
    document.documentElement.append(cursor);
    return cursor;
  };
  const move = (x: number, y: number, ms: number) =>
    new Promise<void>((resolve) => {
      const el = mount();
      const from = `translate(${pos.x}px,${pos.y}px)`;
      pos = { x, y };
      const to = `translate(${x}px,${y}px)`;
      if (ms <= 0) {
        el.style.transform = to;
        resolve();
        return;
      }
      const anim = el.animate([{ transform: from }, { transform: to }], {
        duration: ms,
        easing: ease,
        fill: "forwards",
      });
      anim.onfinish = () => {
        el.style.transform = to;
        anim.cancel();
        resolve();
      };
    });
  const ripple = () => {
    const ring = layer(
      `left:${pos.x - 18}px;top:${pos.y - 18}px;width:40px;height:40px;border-radius:50%;` +
        "border:2px solid rgb(255 255 255 / .9);background:rgb(255 255 255 / .18);",
    );
    document.documentElement.append(ring);
    void ring
      .animate(
        [
          { transform: "scale(.25)", opacity: 1 },
          { transform: "scale(1.2)", opacity: 0 },
        ],
        { duration: 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      )
      .finished.then(() => ring.remove());
  };
  const keys = (label: string) => {
    const pill = layer(
      "left:50%;bottom:44px;transform:translateX(-50%);padding:10px 18px;border-radius:12px;" +
        "font:600 22px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.02em;color:#fff;" +
        "background:rgb(20 20 24 / .82);border:1px solid rgb(255 255 255 / .16);box-shadow:0 8px 30px rgb(0 0 0 / .35);",
    );
    pill.textContent = label;
    document.documentElement.append(pill);
    void pill
      .animate(
        [
          { opacity: 0, translate: "0 8px" },
          { opacity: 1, translate: "0 0", offset: 0.15 },
          { opacity: 1, translate: "0 0", offset: 0.8 },
          { opacity: 0, translate: "0 0" },
        ],
        { duration: 1100, easing: "ease-out" },
      )
      .finished.then(() => pill.remove());
  };
  const showEndCard = async (card: { name: string; tagline: string; detail: string; icon: string }) => {
    cursor?.remove();
    cursor = null;
    const icon = card.icon;
    const el = layer(
      "inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;" +
        "background:rgb(10 10 14 / .55);backdrop-filter:blur(18px) saturate(1.2);color:#fff;" +
        "font-family:ui-sans-serif,system-ui,sans-serif;text-align:center;",
    );
    el.innerHTML = `
      <img src="${icon}" alt="" style="width:120px;height:120px;filter:drop-shadow(0 10px 30px rgb(0 0 0 / .5))">
      <div style="font-weight:700;font-size:76px;letter-spacing:-.02em"></div>
      <div style="font-weight:500;font-size:30px;opacity:.92"></div>
      <div style="font-size:22px;opacity:.65"></div>`;
    const [, name, tagline, detail] = el.children;
    name!.textContent = card.name;
    tagline!.textContent = card.tagline;
    detail!.textContent = card.detail;
    document.documentElement.append(el);
    await el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 450, easing: "ease-out" }).finished;
  };
  window.demoOverlay = { move, ripple, keys, endCard: showEndCard };
}

export async function installOverlay(page: Page): Promise<void> {
  await page.addInitScript(installInPage);
}

/** A point on the element in CSS pixels: its centre, or a fraction across and down it. */
export async function pointOf(target: Locator, fx = 0.5, fy = 0.5): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox();
  if (!box) throw new Error(`no box for ${target.toString()}`);
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

/** Glides the drawn cursor to the point, then puts the real pointer there so hover styles and lines follow. */
export async function glide(page: Page, point: { x: number; y: number }, ms = 380): Promise<void> {
  await page.evaluate((to) => window.demoOverlay.move(to.x, to.y, to.ms), { ...point, ms });
  await page.mouse.move(point.x, point.y);
}

export async function click(page: Page, target: Locator, ms = 380, fx = 0.5, fy = 0.5): Promise<void> {
  const point = await pointOf(target, fx, fy);
  await glide(page, point, ms);
  await page.evaluate(() => window.demoOverlay.ripple());
  await page.mouse.down();
  await page.mouse.up();
}

/** Shows a key pill (e.g. "Shift") while the keys are pressed. */
export async function showKeys(page: Page, label: string): Promise<void> {
  await page.evaluate((l) => window.demoOverlay.keys(l), label);
}

export async function endCard(page: Page, card: EndCard): Promise<void> {
  await page.evaluate((c) => window.demoOverlay.endCard(c), card);
}
