import { ConnectT3Input, MergePrInput, UpdateSettingsInput } from "@repo/contracts";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app.ts";
import { browseDirectory } from "../../fs.ts";
import { actorOf, handle, noContent, parseBody, parseQuery, idParam } from "../respond.ts";

/** Board snapshot, links, settings, integrations and the folder picker. */
export function registerSystemRoutes(app: Hono, { services, integrations }: AppContext): void {
  app.get(
    "/api/board",
    handle((c) => c.json(services.board.snapshot())),
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
    "/api/settings",
    handle((c) => c.json(services.settings.get())),
  );
  app.patch(
    "/api/settings",
    handle(async (c) => c.json(services.settings.update(await parseBody(c, UpdateSettingsInput)))),
  );

  app.get(
    "/api/integrations/status",
    handle((c) => c.json({ t3: integrations.t3Status(), github: integrations.githubStatus() })),
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
