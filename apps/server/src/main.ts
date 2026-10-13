import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.ts";
import { BRAND } from "@repo/contracts";
import { loadConfig } from "./config.ts";
import { createContext } from "./context.ts";

const config = loadConfig();
const ctx = createContext(config);
const app = createApp(ctx);

if (config.webDist && existsSync(config.webDist)) {
  app.use("/*", serveStatic({ root: config.webDist }));
  // SPA fallback for client-side routes.
  app.get("*", serveStatic({ root: config.webDist, path: "index.html" }));
}

if (config.pollers) ctx.integrations.start();

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[${BRAND.id}] listening on http://${config.host}:${info.port}  (data: ${config.homeDir})`);
  console.log(`[${BRAND.id}] MCP endpoint: http://${config.host}:${info.port}/mcp`);
});

function shutdown() {
  ctx.integrations.stop();
  server.close();
  ctx.db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
