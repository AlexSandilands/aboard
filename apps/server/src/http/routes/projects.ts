import {
  CreateProjectInput,
  StartPlanningSessionInput,
  StartPlanningThreadInput,
  StartT3ThreadInput,
  UpdateProjectInput,
} from "@repo/contracts";
import type { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AppContext } from "../../app.ts";
import { AppError } from "../../errors.ts";
import { findIconCandidatesCached, resolveIconFile } from "../../projectIcons.ts";
import { actorOf, handle, noContent, parseBody, parseQuery, queryFlag, idParam } from "../respond.ts";

/** /api/projects */
export function registerProjectRoutes(app: Hono, { services, integrations }: AppContext): void {
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
  // The lane for work with no code project; brought back if it was archived or deleted.
  app.post(
    "/api/projects/general",
    handle((c) => c.json(services.projects.general())),
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
  // Images in the project's folder for the icon picker; none for a project with no folder or one that is gone.
  app.get(
    "/api/projects/:id/icon-candidates",
    handle(async (c) => {
      const { workspaceRoot } = services.projects.get(idParam(c));
      return c.json(workspaceRoot ? await findIconCandidatesCached(workspaceRoot) : []);
    }),
  );
  app.get(
    "/api/projects/:id/icon-candidates/file",
    handle(async (c) => {
      const { workspaceRoot } = services.projects.get(idParam(c));
      const { path } = parseQuery(c, z.object({ path: z.string().min(1).max(1000) }));
      const file = workspaceRoot ? await resolveIconFile(workspaceRoot, path) : null;
      if (!file) throw new AppError("NOT_FOUND", "That image isn't in the project folder");
      const bytes = new Uint8Array(await readFile(file.absolutePath));
      return c.body(bytes, 200, {
        "content-type": file.contentType,
        // An SVG here is only ever shown as an <img>; these stop it running if it is opened on its own.
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
        "cache-control": "private, no-cache",
      });
    }),
  );
  app.get(
    "/api/projects/:id/t3-launch-options",
    handle(async (c) => c.json(await integrations.t3ProjectLaunchOptions(services.projects.get(idParam(c)).id))),
  );
  // Suggest epics; a planning thread has its own route, as it is linked to the tasks it plans.
  app.post(
    "/api/projects/:id/t3-thread",
    handle(async (c) => {
      const project = services.projects.get(idParam(c));
      const input = await parseBody(c, StartT3ThreadInput);
      return c.json(await integrations.startT3ProjectThread(project.id, input, `Suggest epics: ${project.title}`), 201);
    }),
  );
  app.post(
    "/api/projects/:id/plan-thread",
    handle(async (c) => {
      const project = services.projects.get(idParam(c));
      const input = await parseBody(c, StartPlanningThreadInput);
      return c.json(await integrations.startT3PlanningThread(project.id, input, actorOf(c)), 201);
    }),
  );
  app.post(
    "/api/projects/:id/plan-session",
    handle(async (c) => {
      const project = services.projects.get(idParam(c));
      const input = await parseBody(c, StartPlanningSessionInput);
      return c.json(await integrations.startPlanningSession(project.id, input, actorOf(c)), 201);
    }),
  );
}
