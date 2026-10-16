import type { Hono } from "hono";
import type { AppContext } from "../app.ts";
import { registerBackupRoutes } from "./routes/backup.ts";
import { registerLabelRoutes } from "./routes/labels.ts";
import { registerPlanRoutes } from "./routes/plans.ts";
import { registerProjectRoutes } from "./routes/projects.ts";
import { registerReviewRoutes } from "./routes/reviews.ts";
import { registerSystemRoutes } from "./routes/system.ts";
import { registerTaskRoutes } from "./routes/tasks.ts";

/** Registers all /api routes. Handlers are thin: parse → one service call → JSON. */
export function registerApiRoutes(app: Hono, ctx: AppContext): void {
  registerSystemRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerPlanRoutes(app, ctx);
  registerReviewRoutes(app, ctx);
  registerLabelRoutes(app, ctx);
  registerBackupRoutes(app, ctx);
}
