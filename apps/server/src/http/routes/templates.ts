import { CreateTemplateInput, UpdateTemplateInput } from "@repo/contracts";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app.ts";
import { handle, idParam, noContent, parseBody, parseQuery } from "../respond.ts";

const TemplateListQuery = z.object({ projectId: z.string().optional() });

/** /api/templates: templates for new tasks. Agents read them over MCP; only the user edits them. */
export function registerTemplateRoutes(app: Hono, { services }: AppContext): void {
  app.get(
    "/api/templates",
    handle((c) => c.json(services.templates.list(parseQuery(c, TemplateListQuery)))),
  );
  app.post(
    "/api/templates",
    handle(async (c) => c.json(services.templates.create(await parseBody(c, CreateTemplateInput)), 201)),
  );
  app.patch(
    "/api/templates/:id",
    handle(async (c) => c.json(services.templates.update(idParam(c), await parseBody(c, UpdateTemplateInput)))),
  );
  app.post(
    "/api/templates/:id/duplicate",
    handle((c) => c.json(services.templates.duplicate(idParam(c)), 201)),
  );
  app.delete(
    "/api/templates/:id",
    handle((c) => {
      services.templates.delete(idParam(c));
      return noContent(c);
    }),
  );
}
