import { UpdateAutopilotEngineInput, UpdateAutopilotSettingInput } from "@repo/contracts";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app.ts";
import { AppError } from "../../errors.ts";
import { handle, idParam, parseBody, parseQuery } from "../respond.ts";

const automationParam = (c: Context): string => c.req.param("automation") ?? "";

/**
 * /api/autopilot: engine settings, pause, per-scope switches and run history. REST only: there is deliberately no
 * MCP tool for any of this, so agents can't turn Autopilot on or lift its limits (docs/decisions/0008-autopilot-engine.md).
 */
export function registerAutopilotRoutes(app: Hono, { services }: AppContext): void {
  const autopilot = services.autopilot;

  app.get(
    "/api/autopilot",
    handle((c) => c.json(autopilot.overview())),
  );
  app.patch(
    "/api/autopilot/engine",
    handle(async (c) => c.json(autopilot.updateEngine(await parseBody(c, UpdateAutopilotEngineInput)))),
  );
  app.post(
    "/api/autopilot/pause",
    handle((c) => c.json(autopilot.setPaused(true))),
  );
  app.post(
    "/api/autopilot/resume",
    handle((c) => c.json(autopilot.setPaused(false))),
  );

  app.get(
    "/api/autopilot/board",
    handle((c) => c.json(autopilot.scope("board", null))),
  );
  app.put(
    "/api/autopilot/board/:automation",
    handle(async (c) =>
      c.json(autopilot.setScope("board", null, automationParam(c), await parseBody(c, UpdateAutopilotSettingInput))),
    ),
  );
  app.get(
    "/api/autopilot/projects/:id",
    handle((c) => c.json(autopilot.scope("project", idParam(c)))),
  );
  app.put(
    "/api/autopilot/projects/:id/:automation",
    handle(async (c) =>
      c.json(
        autopilot.setScope("project", idParam(c), automationParam(c), await parseBody(c, UpdateAutopilotSettingInput)),
      ),
    ),
  );

  app.get(
    "/api/autopilot/runs",
    handle((c) => {
      const query = parseQuery(
        c,
        z.object({
          taskId: z.string().min(1).optional(),
          projectId: z.string().min(1).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      );
      if (query.taskId) {
        return c.json(autopilot.runsForTask(services.tasks.resolveId(query.taskId), query.limit));
      }
      if (query.projectId) {
        const project = services.projects.get(query.projectId);
        return c.json(autopilot.runsForProject(project.id, query.limit));
      }
      throw new AppError("VALIDATION", "Pass taskId or projectId");
    }),
  );
}
