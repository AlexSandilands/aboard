import {
  automationBundle,
  BUNDLE_SKILL_BODY_MAX,
  BundleSkill,
  CreateCustomAutomationInput,
  ImportAutomationInput,
  parseAutomationBundle,
  UpdateCustomAutomationInput,
  type CustomAction,
} from "@repo/contracts";
import type { Context, Hono } from "hono";
import type { AppContext } from "../../app.ts";
import { AppError } from "../../errors.ts";
import { installSkill, readInstalledSkill } from "../../skills.ts";
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
export function registerCustomAutomationRoutes(app: Hono, { services, config }: AppContext): void {
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
  // A shared file (docs/features/autopilot.md#sharing-automations): the definition without the sharer's projects, epic and slot
  // tools, and the skill it names when that is one of the user's own.
  app.get(
    "/api/autopilot/custom/:id/export",
    handle((c) => {
      const automation = custom.get(idParam(c));
      const name = automation.action.kind === "agent" ? automation.action.skill : "";
      const body = name ? readInstalledSkill(config.userHome, name) : null;
      const skill = body && body.length <= BUNDLE_SKILL_BODY_MAX ? BundleSkill.safeParse({ name, body }) : null;
      return c.json(automationBundle(automation, skill?.success ? skill.data : null));
    }),
  );
  app.post(
    "/api/autopilot/custom/import",
    handle(async (c) => {
      const input = await parseBody(c, ImportAutomationInput);
      // A file's shell command runs on this machine, so, as when writing one by hand, only the board's page may import it.
      const parsed = parseAutomationBundle(input.bundle);
      if (parsed.ok) assertShellFromBrowser(c, parsed.bundle.action);
      // A skill persists into every later session that reads the user's skills, so it is held to the same rail.
      if (parsed.ok && parsed.bundle.skill && input.installSkill && !c.req.header("origin")) {
        throw new AppError("VALIDATION", "Skills can only be installed from the board's settings page");
      }
      return c.json(
        custom.importBundle(input, (skill) => installSkill(config.userHome, skill)),
        201,
      );
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
