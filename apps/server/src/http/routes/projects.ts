import { CreateProjectInput, UpdateProjectInput } from "@repo/contracts";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app.ts";
import { handle, noContent, parseBody, parseQuery, queryFlag, idParam } from "../respond.ts";

/** /api/projects */
export function registerProjectRoutes(app: Hono, { services }: AppContext): void {
  app.get(
    "/api/projects",
    handle((c) => {
      const { includeArchived } = parseQuery(c, z.object({ includeArchived: queryFlag }));
      return c.json(services.projects.list({ includeArchived }));
    }),
  );
  app.post(
    "/api/projects",
    handle(async (c) => c.json(services.projects.create(await parseBody(c, CreateProjectInput)), 201)),
  );
  app.post(
    "/api/projects/reorder",
    handle(async (c) => {
      const { ids } = await parseBody(c, z.object({ ids: z.array(z.string()) }));
      services.projects.reorder(ids);
      return noContent(c);
    }),
  );
  app.patch(
    "/api/projects/:id",
    handle(async (c) => c.json(services.projects.update(idParam(c), await parseBody(c, UpdateProjectInput)))),
  );
  app.delete(
    "/api/projects/:id",
    handle((c) => {
      services.projects.delete(idParam(c));
      return noContent(c);
    }),
  );
}
