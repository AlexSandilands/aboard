import { UpdateAutopilotEngineInput, UpdateAutopilotSettingInput } from "@repo/contracts";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app.ts";
import { orchestrateState, requestOrchestrateRun } from "../../autopilot/automations/orchestrate.ts";
import { AppError } from "../../errors.ts";
import { actorOf, handle, idParam, parseBody, parseQuery } from "../respond.ts";

const automationParam = (c: Context): string => c.req.param("automation") ?? "";
const epicParam = (c: Context): string => c.req.param("epicId") ?? "";

/**
 * /api/autopilot: engine settings, pause, per-scope switches and run history. REST only: there is deliberately no
 * MCP tool for any of this, so agents can't turn Autopilot on or lift its limits (docs/decisions/0008-autopilot-engine.md).
 * Retrying a run is the exception (retry_autopilot_run): it lifts no limit, since the engine still decides.
 */
export function registerAutopilotRoutes(app: Hono, { services, integrations }: AppContext): void {
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

  // Orchestrate in one project, and Run now. The request publishes autopilot.changed, which starts a pass a second
  // later; the pass started here doesn't wait for that.
  app.get(
    "/api/autopilot/orchestrate/:id",
    handle((c) => c.json(orchestrateState(services, idParam(c), new Date()))),
  );
  app.post(
    "/api/autopilot/orchestrate/:id/run",
    handle((c) => {
      const state = requestOrchestrateRun(services, idParam(c), new Date());
      integrations.autopilotPass();
      return c.json(state, 202);
    }),
  );

  // The digest of what changed (docs/features/autopilot.md#automations). Registered before /:id/read.
  app.get(
    "/api/autopilot/digests",
    handle((c) => c.json(services.digests.list())),
  );
  app.post(
    "/api/autopilot/digests",
    handle(async (c) => {
      const started = await integrations.generateDigest();
      // 202: an agent is writing it, and the digest arrives with autopilot.changed.
      return c.json(started, started.digest ? 201 : 202);
    }),
  );
  app.post(
    "/api/autopilot/digests/:id/read",
    handle((c) => c.json(services.digests.markRead(idParam(c)))),
  );

  // An epic's switches: only for an epic in that project, anything else is not found.
  app.get(
    "/api/autopilot/projects/:id/epics/:epicId",
    handle((c) => c.json(autopilot.scope("epic", epicParam(c), idParam(c)))),
  );
  app.put(
    "/api/autopilot/projects/:id/epics/:epicId/:automation",
    handle(async (c) =>
      c.json(
        autopilot.setScope(
          "epic",
          epicParam(c),
          automationParam(c),
          await parseBody(c, UpdateAutopilotSettingInput),
          idParam(c),
        ),
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
  app.post(
    "/api/autopilot/runs/:id/retry",
    handle((c) => c.json(autopilot.retry(idParam(c), actorOf(c)))),
  );
}
