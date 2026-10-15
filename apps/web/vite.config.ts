import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { BRAND, brandEnv, storageKey } from "../../packages/contracts/src/brand.ts";

const serverPort = Number(process.env[brandEnv("PORT")] ?? 4317);
const target = `http://127.0.0.1:${serverPort}`;
// The server's Origin guard reads the same variable, so Vite on another port can still write.
const webPort = Number(process.env[brandEnv("WEB_PORT")] ?? 5317);

/** Fills brand placeholders in index.html (`%BRAND_NAME%`, `%THEME_STORAGE_KEY%`). */
function brandHtml(): Plugin {
  return {
    name: "brand-html",
    transformIndexHtml: {
      order: "pre",
      handler: (html) =>
        html.replaceAll("%BRAND_NAME%", BRAND.name).replaceAll("%THEME_STORAGE_KEY%", storageKey("theme")),
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
