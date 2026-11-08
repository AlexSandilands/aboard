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
/** The solid "A" and card bar on a transparent background; the white and black tray icons are recoloured from it. */
const MONO_SOURCE = `${root}assets/a-card-mono.svg`;
/** Tray sizes for 100/150/200% scaling; Electron picks the `@Nx` file that matches the display. */
const TRAY_SIZES: Record<string, number> = { "": 16, "@1.5x": 24, "@2x": 32 };
/**
 * The tray icon styles. The mono ones take the panel's foreground colour for the glyph and ring the unread dot
 * in the opposite one, so it stands off the glyph on a panel of the matching colour.
 */
const TRAY_STYLES = [
  { prefix: "tray", glyph: null, ring: "#16161b" },
  { prefix: "tray-white", glyph: "#ffffff", ring: "#16161b" },
  { prefix: "tray-black", glyph: "#000000", ring: "#ffffff" },
];
/**
 * Tray menu icons: Lucide's 24px outlines (ISC licence), inlined so there is no icon package to bundle. Names are
 * what `menuIcon` in `src/icon.ts` takes.
 */
const MENU_ICONS: Record<string, string> = {
  "app-window":
    '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  palette:
    '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
  "rotate-cw": '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  square: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  "square-check": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>',
  search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
  download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  rocket:
    '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  "external-link":
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
};
/** The stroke colour per menu theme: the set is named for the theme it is drawn for, so "light" is dark ink. */
const MENU_THEMES = { light: "#27272a", dark: "#e4e4e7" };
const MENU_ICON_SIZE = 16;
/** Window/taskbar, and the installer (electron-builder converts it to .ico). */
const APP_ICON_SIZE = 256;

rmSync(`${root}dist`, { recursive: true, force: true });
await build({
  entryPoints: [`${root}src/main.ts`],
  outfile: `${root}dist/main.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["electron"],
  // electron-updater is CommonJS and requires Node's built-ins, which an ESM bundle can only do through this.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
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

const svg = readFileSync(ICON_SOURCE, "utf8");
const mono = readFileSync(MONO_SOURCE, "utf8");
const rasterise = (source: string, size: number) =>
  new Resvg(source, { fitTo: { mode: "width", value: size } }).render().asPng();
/** The unread dot: red, ringed so it reads against the glyph and any tray background. */
const unreadDot = (ring: string) =>
  `<circle cx="23.5" cy="8.5" r="5.5" fill="#ef4444" stroke="${ring}" stroke-width="2"/></svg>`;

mkdirSync(`${root}dist/icons`);
writeFileSync(`${root}dist/icons/icon.png`, rasterise(svg, APP_ICON_SIZE));
for (const { prefix, glyph, ring } of TRAY_STYLES) {
  // The colour icon's viewBox is 0 0 32 32, so its dot sits further out than the mono icons' (viewBox 2 2 28 28).
  const base = glyph ? mono.replaceAll("currentColor", glyph) : svg;
  const dot = glyph ? unreadDot(ring) : unreadDot(ring).replace('cx="23.5" cy="8.5" r="5.5"', 'cx="24" cy="8" r="8"');
  const unread = base.replace("</svg>", dot);
  for (const [suffix, size] of Object.entries(TRAY_SIZES)) {
    writeFileSync(`${root}dist/icons/${prefix}${suffix}.png`, rasterise(base, size));
    writeFileSync(`${root}dist/icons/${prefix}-unread${suffix}.png`, rasterise(unread, size));
  }
}

for (const [theme, color] of Object.entries(MENU_THEMES)) {
  mkdirSync(`${root}dist/icons/menu/${theme}`, { recursive: true });
  for (const [name, body] of Object.entries(MENU_ICONS)) {
    const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body.replaceAll("currentColor", color)}</svg>`;
    for (const [suffix, scale] of [
      ["", 1],
      ["@2x", 2],
    ] as const) {
      writeFileSync(`${root}dist/icons/menu/${theme}/${name}${suffix}.png`, rasterise(icon, MENU_ICON_SIZE * scale));
    }
  }
}
