import {
  AgentHarness,
  AskSettingsInput,
  ConnectT3Input,
  MergePrInput,
  ResumeMode,
  ResumeSessionInput,
  StatsQuery,
  UpdateSettingsInput,
} from "@repo/contracts";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app.ts";
import { manualFix } from "../../autopilot/automations/fixPrs.ts";
import { browseDirectory } from "../../fs.ts";
import { actorOf, handle, noContent, parseBody, parseQuery, idParam } from "../respond.ts";

/** Board snapshot, links, settings, integrations and the folder picker. */
export function registerSystemRoutes(app: Hono, { services, integrations }: AppContext): void {
  app.get(
    "/api/board",
    handle((c) => c.json(services.board.snapshot())),
  );

  // Weekly trends: `weeks` is 1 (by day), 4, 12 (default) or 52; `projectIds` (comma-separated; `projectId` for one) limits them to those projects.
  app.get(
    "/api/stats",
    handle(async (c) => {
      const { weeks, projectIds } = parseQuery(c, StatsQuery);
      return c.json(await services.stats.weekly(weeks, projectIds));
    }),
  );

  app.delete(
    "/api/links/:id",
    handle((c) => {
      services.links.remove(idParam(c), actorOf(c));
      return noContent(c);
    }),
  );
  app.post(
    "/api/links/:id/refresh",
    handle(async (c) => {
      const id = idParam(c);
      services.links.get(id);
      await integrations.refreshLink(id);
      return c.json(services.links.get(id));
    }),
  );
  app.post(
    "/api/links/:id/merge",
    handle(async (c) => {
      const id = idParam(c);
      const input = await parseBody(c, MergePrInput);
      services.links.get(id);
      await integrations.mergePr(id, input);
      return c.json(services.links.get(id));
    }),
  );

  app.get(
    "/api/links/:id/fix",
    // `harness`: the CLI the fix starts in, as one that picks its own session id is told to link itself.
    handle((c) => {
      const { harness } = parseQuery(c, z.object({ harness: AgentHarness.optional() }));
      return c.json(manualFix(services, idParam(c), (pr) => integrations.prAgentHints(pr), harness));
    }),
  );
  app.get(
    "/api/links/:id/resume-command",
    handle((c) => {
      const { mode } = parseQuery(c, z.object({ mode: ResumeMode.default("resume") }));
      return c.json(integrations.resumeCommand(idParam(c), mode));
    }),
  );
  app.post(
    "/api/links/:id/resume",
    handle(async (c) => c.json(await integrations.resumeSession(idParam(c), await parseBody(c, ResumeSessionInput)))),
  );
  app.get(
    "/api/terminal",
    handle((c) => c.json(integrations.terminalInfo())),
  );
  // Every provider as detected here: CLI, MCP registration, T3 Code and the models scan. `?refresh=1` skips the
  // minute's cache; `?parts=cli` answers with the CLIs and T3 Code only, without the slow MCP checks and scans.
  app.get(
    "/api/providers",
    handle(async (c) => {
      const { refresh, parts } = parseQuery(
        c,
        z.object({ refresh: z.string().optional(), parts: z.enum(["all", "cli"]).optional() }),
      );
      return c.json(await integrations.providers(refresh === "1", parts));
    }),
  );

  // Asks each CLI which models it lists, for Settings → Agents → Models; `?refresh=1` skips the ten minutes' cache.
  app.get(
    "/api/agent-models",
    handle(async (c) => {
      const { refresh } = parseQuery(c, z.object({ refresh: z.string().optional() }));
      return c.json(await integrations.agentModels(refresh === "1"));
    }),
  );

  app.get(
    "/api/settings",
    handle((c) => c.json(services.settings.get())),
  );
  app.patch(
    "/api/settings",
    handle(async (c) => c.json(services.settings.update(await parseBody(c, UpdateSettingsInput)))),
  );

  app.post(
    "/api/settings/ask",
    handle(async (c) => c.json(await integrations.askSettings(await parseBody(c, AskSettingsInput)))),
  );

  app.get(
    "/api/integrations/status",
    handle((c) => c.json({ t3: integrations.t3Status(), gitHosts: integrations.gitHostStatuses() })),
  );
  app.get(
    "/api/integrations/t3/status",
    handle((c) => c.json(integrations.t3Status())),
  );
  app.get(
    "/api/integrations/t3/projects",
    handle(async (c) => c.json(await integrations.listT3Projects())),
  );
  const importProjects = handle(async (c) => {
    const { t3ProjectIds } = await parseBody(c, z.object({ t3ProjectIds: z.array(z.string()).min(1) }));
    return c.json(await integrations.importT3Projects(t3ProjectIds));
  });
  app.post("/api/integrations/t3/import", importProjects);
  app.post("/api/integrations/t3/import-projects", importProjects);
  app.get(
    "/api/integrations/t3/models",
    handle(async (c) => c.json(await integrations.t3ModelCatalog())),
  );
  app.post(
    "/api/integrations/t3/test",
    handle(async (c) => c.json(await integrations.testT3())),
  );
  app.post(
    "/api/integrations/t3/connect",
    handle(async (c) => c.json(await integrations.connectT3((await parseBody(c, ConnectT3Input)).value))),
  );

  app.get(
    "/api/fs/browse",
    handle((c) => {
      const { path } = parseQuery(c, z.object({ path: z.string().optional() }));
      return c.json(browseDirectory(path));
    }),
  );
}
