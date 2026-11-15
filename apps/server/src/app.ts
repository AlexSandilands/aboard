import { BRAND, type Health } from "@repo/contracts";
import { Hono } from "hono";
import type { Config } from "./config.ts";
import type { EventBus } from "./bus.ts";
import type { Services } from "./services/types.ts";
import type { Integrations } from "./integrations/types.ts";
import { registerSse } from "./sse.ts";
import { registerApiRoutes } from "./http/routes.ts";
import { createMachineToolCaller, registerMcp } from "./mcp/server.ts";
import { registerRunMcp } from "./mcp/runTools.ts";
import { guard } from "./http/guard.ts";
import { registerMachineRoutes } from "./http/routes/machine.ts";
import { registerHostedRunnerForwarding } from "./http/hostedForward.ts";
import type { HostedRunner } from "./hostedRunner.ts";

export interface AppContext {
  config: Pick<Config, "port" | "webPort" | "token" | "userHome"> &
    Partial<Pick<Config, "webDist" | "demo" | "role" | "bind" | "hostedBy">>;
  /** This server's identity (instance.ts), which the machine descriptor reports. */
  instanceId: string;
  bus: EventBus;
  services: Services;
  integrations: Integrations;
  /** A board's: the runner it hosts for another board when the user lets other machines run tasks here. */
  hostedRunner?: HostedRunner;
}

/** Composes the HTTP app. Exported separately from main.ts so tests can drive it via app.request(). */
export function createApp(ctx: AppContext): Hono {
  const app = new Hono();
  app.use("*", guard({ config: ctx.config, verifyMachineToken: (token) => ctx.services.machineAuth.verify(token) }));
  app.get("/api/health", (c) =>
    c.json({ ok: true, id: BRAND.id, version: BRAND.version, role: ctx.config.role ?? "board" } satisfies Health),
  );
  // Before the routes: a task the hosted runner holds is the runner's to answer for.
  if (ctx.hostedRunner) registerHostedRunnerForwarding(app, ctx.hostedRunner);
  registerSse(app, ctx.bus);
  registerMachineRoutes(app, ctx);
  registerApiRoutes(app, ctx);
  registerMcp(app, ctx);
  registerRunMcp(app, () => ctx.integrations.runTools);
  // A machine holding tasks for this board reads the others through it.
  if ((ctx.config.role ?? "board") === "board")
    ctx.integrations.machineSync.setToolCaller(createMachineToolCaller(app, ctx));
  return app;
}
