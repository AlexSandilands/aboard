import { CreateRecurringRuleInput, UpdateRecurringRuleInput } from "@repo/contracts";
import type { Hono } from "hono";
import type { AppContext } from "../../app.ts";
import { handle, idParam, noContent, parseBody } from "../respond.ts";

/**
 * Recurring-task rules (docs/features/autopilot.md). REST only, like the rest of Autopilot: an agent can't schedule
 * work for itself.
 */
export function registerRecurringRoutes(app: Hono, { services }: AppContext): void {
  app.get(
    "/api/projects/:id/recurring",
    handle((c) => c.json(services.recurring.list(idParam(c)))),
  );
  app.post(
    "/api/projects/:id/recurring",
    handle(async (c) =>
      c.json(services.recurring.create(idParam(c), await parseBody(c, CreateRecurringRuleInput)), 201),
    ),
  );
  app.patch(
    "/api/recurring/:id",
    handle(async (c) => c.json(services.recurring.update(idParam(c), await parseBody(c, UpdateRecurringRuleInput)))),
  );
  app.delete(
    "/api/recurring/:id",
    handle((c) => {
      services.recurring.delete(idParam(c));
      return noContent(c);
    }),
  );
}
