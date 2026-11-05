// Temporary (task #97): headless screenshots of Settings → Agents in each competing design and a few fixed provider
// setups, so the designs can be compared side by side. Goes with the variant dropdown once one design is picked.
//
//   node scripts/agents-shots.ts <sandbox url> <out dir> [variant ids…]   (default: baseline)
//
// It changes the sandbox's providers setting, so point it only at a sandbox (`pnpm sandbox`).
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const [url, out, ...variants] = process.argv.slice(2);
if (!url || !out) {
  console.error("usage: node scripts/agents-shots.ts <sandbox url> <out dir> [variant ids…]");
  process.exit(1);
}
const brand = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string }).name;

/** Provider setups: none, one connected beside one that isn't, and every provider with one switched off. */
const SETUPS: Record<string, Array<{ id: string; enabled: boolean }>> = {
  empty: [],
  two: [
    { id: "t3-code", enabled: true },
    { id: "claude-code", enabled: true },
  ],
  all: [
    { id: "claude-code", enabled: true },
    { id: "codex", enabled: true },
    { id: "copilot-cli", enabled: true },
    { id: "t3-code", enabled: false },
  ],
};
const WIDTHS = { wide: 1440, narrow: 760 };

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const variant of variants.length ? variants : ["baseline"]) {
    for (const [setup, providers] of Object.entries(SETUPS)) {
      const res = await fetch(new URL("/api/settings", url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providers }),
      });
      if (!res.ok) throw new Error(`PATCH /api/settings: ${res.status} ${await res.text()}`);
      for (const [width, px] of Object.entries(WIDTHS)) {
        const context = await browser.newContext({ viewport: { width: px, height: 900 }, colorScheme: "dark" });
        await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
          `${brand}:agents-variant`,
          JSON.stringify({ state: { variant }, version: 0 }),
        ] as const);
        const page = await context.newPage();
        await page.goto(new URL("/settings/agents", url).toString(), { waitUntil: "networkidle" });
        await page.waitForTimeout(1500);
        // The page scrolls inside its own scroller, so grow the viewport to the content's height to get all of it.
        const height = await page.evaluate(() => {
          const scroller = document.querySelector("[data-settings-section]")?.closest("[class*='overflow-y']");
          return Math.min(8000, Math.max(900, (scroller?.scrollHeight ?? 900) + 120));
        });
        await page.setViewportSize({ width: px, height });
        await page.waitForTimeout(500);
        const file = join(out, `${variant}--${setup}--${width}.png`);
        await page.screenshot({ path: file });
        console.log(file);
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}
