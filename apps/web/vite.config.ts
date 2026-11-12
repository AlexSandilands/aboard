import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { BRAND, brandEnv, storageKey } from "../../packages/contracts/src/brand.ts";
import { buildPaintSnapshot, DEFAULT_THEME_ID } from "./src/theme/themeState.logic.ts";

const serverPort = Number(process.env[brandEnv("PORT")] ?? 4317);
const target = `http://127.0.0.1:${serverPort}`;
// The server's Origin guard reads the same variable, so Vite on another port can still write.
const webPort = Number(process.env[brandEnv("WEB_PORT")] ?? 5317);

/**
 * The default theme's paint snapshot, for the boot script to paint a new browser with before the app loads. The mode
 * doesn't matter: the snapshot has an entry for each appearance.
 */
const defaultThemePaint = JSON.stringify(
  buildPaintSnapshot({ mode: "dark", themeId: DEFAULT_THEME_ID, halves: {} }, []),
);

/**
 * Fills placeholders in index.html: `%BRAND_NAME%`, `%STORAGE_KEY(name)%` for `storageKey("name")` and
 * `%DEFAULT_THEME_PAINT%`.
 */
function brandHtml(): Plugin {
  return {
    name: "brand-html",
    transformIndexHtml: {
      order: "pre",
      handler: (html) =>
        html
          .replaceAll("%BRAND_NAME%", BRAND.name)
          .replaceAll("%DEFAULT_THEME_PAINT%", defaultThemePaint)
          .replace(/%STORAGE_KEY\(([a-z-]+)\)%/g, (_match, name: string) => storageKey(name)),
    },
  };
}

export default defineConfig({
  plugins: [brandHtml(), react(), tailwindcss()],
  resolve: {
    alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": { target, changeOrigin: false },
      "/mcp": { target, changeOrigin: false },
      "/events": {
        target,
        changeOrigin: false,
        // When the dev server restarts mid-stream the proxy logs the reset but leaves the browser's side
        // open, so EventSource never notices and the board goes stale. Drop it so the client reconnects.
        configure: (proxy) => {
          proxy.on("error", (_error, _req, res) => {
            res.destroy();
          });
        },
      },
    },
  },
  test: {
    environment: "node",
  },
});
