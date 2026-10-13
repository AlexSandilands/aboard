import { Hono } from "hono";
import type { Config } from "./config.ts";
import type { EventBus } from "./bus.ts";
import type { Services } from "./services/types.ts";
import type { Integrations } from "./integrations/types.ts";
import { registerSse } from "./sse.ts";
import { registerApiRoutes } from "./http/routes.ts";
import { registerMcp } from "./mcp/server.ts";
import { localGuard } from "./http/guard.ts";

export interface AppContext {
  config: Pick<Config, "port" | "token">;
  bus: EventBus;
  services: Services;
  integrations: Integrations;
}

/** Composes the HTTP app. Exported separately from main.ts so tests can drive it via app.request(). */
export function createApp(ctx: AppContext): Hono {
  const app = new Hono();
  app.use("*", localGuard(ctx.config));
  app.get("/api/health", (c) => c.json({ ok: true }));
  registerSse(app, ctx.bus);
  registerApiRoutes(app, ctx);
  registerMcp(app, ctx);
  return app;
}
