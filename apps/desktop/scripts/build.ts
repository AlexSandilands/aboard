/**
 * Bundles the Electron main process (and @repo/contracts, which is TS source) into `dist/main.mjs`, the
 * preload into `dist/preload.cjs` (sandboxed preloads can't be ESM), and rasterises the web favicon into `dist/icons/` (Electron can't load SVG icons on Windows).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
/** The same icon `apps/web/index.html` uses as its favicon. */
const ICON_SOURCE = `${root}../web/public/favicons/a-card.svg`;
/** Tray sizes for 100/150/200% scaling; Electron picks the `@Nx` file that matches the display. */
const ICONS: Record<string, number> = {
  "tray.png": 16,
  "tray@1.5x.png": 24,
  "tray@2x.png": 32,
  // Window/taskbar, and the installer (electron-builder converts it to .ico).
  "icon.png": 256,
};

rmSync(`${root}dist`, { recursive: true, force: true });
await build({
  entryPoints: [`${root}src/main.ts`],
  outfile: `${root}dist/main.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["electron"],
  logLevel: "warning",
});
await build({
  entryPoints: [`${root}src/preload.ts`],
  outfile: `${root}dist/preload.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "chrome140",
  external: ["electron"],
  logLevel: "warning",
});

const svg = readFileSync(ICON_SOURCE);
mkdirSync(`${root}dist/icons`);
for (const [name, size] of Object.entries(ICONS)) {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
  writeFileSync(`${root}dist/icons/${name}`, png);
}
