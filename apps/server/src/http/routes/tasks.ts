import {
  CloseTaskInput,
  CreateTaskInput,
  LinkInput,
  MoveTaskInput,
  PlanInput,
  StartT3ThreadInput,
  TaskStatus,
  UpdateTaskInput,
  ACTOR_HEADER,
} from "@repo/contracts";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app.ts";
import { actorOf, handle, noContent, parseBody, parseQuery, queryFlag, idParam } from "../respond.ts";

const TaskListQuery = z.object({
  projectId: z.string().optional(),
  status: TaskStatus.optional(),
  q: z.string().optional(),
  includeArchived: queryFlag,
  attention: queryFlag,
});

/** /api/tasks — task cards, plan replacement, phases, links and notes scoped to a task. */
export function registerTaskRoutes(app: Hono, { services, integrations }: AppContext): void {
  const taskId = (c: Context) => services.tasks.resolveId(idParam(c));

  app.get(
    "/api/tasks",
    handle((c) => {
      const q = parseQuery(c, TaskListQuery);
      return c.json(
        services.tasks.summaries({
          projectId: q.projectId,
          status: q.status,
          query: q.q,
          includeArchived: q.includeArchived,
          attentionOnly: q.attention,
        }),
      );
    }),
  );
  app.post(
    "/api/tasks",
    handle(async (c) => {
      const input = await parseBody(c, CreateTaskInput);
      const actor = c.req.header(ACTOR_HEADER)?.trim() || input.actor || actorOf(c);
      return c.json(services.tasks.create({ ...input, actor }), 201);
    }),
  );
  app.get(
    "/api/tasks/:id",
    handle((c) => c.json(services.tasks.detail(taskId(c)))),
  );
  app.patch(
    "/api/tasks/:id",
    handle(async (c) => c.json(services.tasks.update(taskId(c), await parseBody(c, UpdateTaskInput), actorOf(c)))),
  );
  app.delete(
    "/api/tasks/:id",
    handle((c) => {
      services.tasks.delete(taskId(c), actorOf(c));
      return noContent(c);
    }),
  );
  app.get(
    "/api/tasks/:id/t3-launch-options",
    handle(async (c) => c.json(await integrations.t3LaunchOptions(taskId(c)))),
  );
  app.post(
    "/api/tasks/:id/t3-thread",
    handle(async (c) => {
      const id = taskId(c);
      const input = await parseBody(c, StartT3ThreadInput);
      return c.json(await integrations.startT3Thread(id, input, actorOf(c)), 201);
    }),
  );
  app.post(
    "/api/tasks/:id/move",
    handle(async (c) => c.json(services.tasks.move(taskId(c), await parseBody(c, MoveTaskInput), actorOf(c)))),
  );
  app.post(
    "/api/tasks/:id/close",
    handle(async (c) => {
      const id = taskId(c);
      const { resolution, byTask } = await parseBody(c, CloseTaskInput);
      const byTaskId = byTask ? services.tasks.resolveId(byTask) : undefined;
      return c.json(services.tasks.close(id, { resolution, ...(byTaskId ? { byTaskId } : {}) }, actorOf(c)));
    }),
  );
  app.put(
    "/api/tasks/:id/plan",
    handle(async (c) => c.json(services.plans.setPlan(taskId(c), await parseBody(c, PlanInput), actorOf(c)))),
  );
  app.post(
    "/api/tasks/:id/phases",
    handle(async (c) => {
      const body = await parseBody(
        c,
        z.object({ title: z.string().trim().min(1), afterPhaseId: z.string().optional() }),
      );
      return c.json(
        services.plans.addPhase(taskId(c), body.title, actorOf(c), { afterPhaseId: body.afterPhaseId }),
        201,
      );
    }),
  );
  app.post(
    "/api/tasks/:id/links",
    handle(async (c) => c.json(services.links.add(taskId(c), await parseBody(c, LinkInput), actorOf(c)), 201)),
  );
  app.post(
    "/api/tasks/:id/notes",
    handle(async (c) => {
      const { text } = await parseBody(c, z.object({ text: z.string().trim().min(1) }));
      return c.json(services.tasks.addNote(taskId(c), text, actorOf(c)), 201);
    }),
  );
}
