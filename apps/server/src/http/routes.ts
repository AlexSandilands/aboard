import type { Hono } from "hono";
import type { AppContext } from "../app.ts";
import { registerAttachmentRoutes } from "./routes/attachments.ts";
import { registerAutopilotRoutes } from "./routes/autopilot.ts";
import { registerBackupRoutes } from "./routes/backup.ts";
import { registerDemoRoutes } from "./routes/demo.ts";
import { registerLabelRoutes } from "./routes/labels.ts";
import { registerNotificationRoutes } from "./routes/notifications.ts";
import { registerSocialRoutes } from "./routes/social.ts";
import { registerSkillSyncRoutes } from "./routes/skillSync.ts";
import { registerSuggestionRoutes } from "./routes/suggestions.ts";
import { registerPlanRoutes } from "./routes/plans.ts";
import { registerProjectRoutes } from "./routes/projects.ts";
import { registerRecurringRoutes } from "./routes/recurring.ts";
import { registerCustomAutomationRoutes } from "./routes/customAutomations.ts";
import { registerReviewRoutes } from "./routes/reviews.ts";
import { registerSystemRoutes } from "./routes/system.ts";
import { registerTemplateRoutes } from "./routes/templates.ts";
import { registerTaskRoutes } from "./routes/tasks.ts";

/** Registers all /api routes. Handlers are thin: parse → one service call → JSON. */
export function registerApiRoutes(app: Hono, ctx: AppContext): void {
  registerSystemRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerPlanRoutes(app, ctx);
  registerAttachmentRoutes(app, ctx);
  registerReviewRoutes(app, ctx);
  registerLabelRoutes(app, ctx);
  registerTemplateRoutes(app, ctx);
  registerBackupRoutes(app, ctx);
  registerAutopilotRoutes(app, ctx);
  registerRecurringRoutes(app, ctx);
  registerCustomAutomationRoutes(app, ctx);
  registerNotificationRoutes(app, ctx);
  registerSocialRoutes(app, ctx);
  registerSuggestionRoutes(app, ctx);
  registerSkillSyncRoutes(app, ctx);
  if (ctx.config.demo) registerDemoRoutes(app, ctx);
}
