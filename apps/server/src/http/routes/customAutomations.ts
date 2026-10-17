import { CreateCustomAutomationInput, UpdateCustomAutomationInput, type CustomAction } from "@repo/contracts";
import type { Context, Hono } from "hono";
import type { AppContext } from "../../app.ts";
import { AppError } from "../../errors.ts";
import { handle, idParam, noContent, parseBody } from "../respond.ts";

/**
 * A shell action runs whatever it says, so only the board's own page may write one: browsers always send an Origin
 * (which the guard checks is this board), while agents and scripts usually send none. A guard rail on top of REST
 * only, not a boundary: anything on this machine can set the header.
 */
function assertShellFromBrowser(c: Context, action: Pick<CustomAction, "kind"> | undefined): void {
  if (action?.kind !== "shell") return;
  if (!c.req.header("origin")) {
    throw new AppError("VALIDATION", "Shell commands can only be set from the board's settings page");
  }
}

/**
 * Custom automations (docs/features/autopilot.md#custom-automations). REST only, like the rest of Autopilot: there is
 * no MCP tool, so an agent can't define work for itself or a command to run.
 */
export function registerCustomAutomationRoutes(app: Hono, { services }: AppContext): void {
  const custom = services.customAutomations;

  app.get(
    "/api/autopilot/custom",
    handle((c) => c.json(custom.list())),
  );
  app.post(
    "/api/autopilot/custom",
    handle(async (c) => {
      const input = await parseBody(c, CreateCustomAutomationInput);
      assertShellFromBrowser(c, input.action);
      return c.json(custom.create(input), 201);
    }),
  );
  app.patch(
    "/api/autopilot/custom/:id",
    handle(async (c) => {
      const input = await parseBody(c, UpdateCustomAutomationInput);
      // Any change to a shell automation changes what runs or when.
      assertShellFromBrowser(c, input.action ?? custom.get(idParam(c)).action);
      return c.json(custom.update(idParam(c), input));
    }),
  );
  app.delete(
    "/api/autopilot/custom/:id",
    handle((c) => {
      custom.delete(idParam(c));
      return noContent(c);
    }),
  );
}
