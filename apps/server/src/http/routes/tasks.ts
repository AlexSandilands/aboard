import {
  type AddLinkResult,
  CloseTaskInput,
  CreateTaskInput,
  LinkInput,
  MoveTaskInput,
  PlanInput,
  SetDeliveryInput,
  StartSessionInput,
  StartT3ThreadInput,
  TaskStatusInput,
  UpdateTaskInput,
  ACTOR_HEADER,
} from "@repo/contracts";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app.ts";
import { actorOf, handle, noContent, parseBody, parseQuery, queryFlag, idParam } from "../respond.ts";

const TaskListQuery = z.object({
  projectId: z.string().optional(),
  status: TaskStatusInput.optional(),
  q: z.string().optional(),
  /** Comma-separated; tasks with any of them. */
  labels: z.string().optional(),
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
          ...(q.labels ? { labels: q.labels.split(",").filter((l) => l.trim()) } : {}),
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
      const task = services.tasks.create({ ...input, actor });
      if (task.import?.status === "pending") integrations.startImport(task.id);
      return c.json(task, 201);
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
  app.put(
    "/api/tasks/:id/delivery",
    handle(async (c) => {
      const id = taskId(c);
      const input = await parseBody(c, SetDeliveryInput);
      return c.json(await integrations.setEpicDelivery(id, input.delivery, actorOf(c)));
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
  app.get(
    "/api/tasks/:id/session-launch-options",
    handle(async (c) => c.json(await integrations.sessionLaunchOptions(taskId(c)))),
  );
  app.post(
    "/api/tasks/:id/sessions",
    handle(async (c) => {
      const id = taskId(c);
      const input = await parseBody(c, StartSessionInput);
      return c.json(await integrations.startSession(id, input, actorOf(c)), 201);
    }),
  );
  app.post(
    "/api/tasks/:id/import/retry",
    handle((c) => {
      const id = taskId(c);
      services.imports.retry(id, actorOf(c));
      integrations.startImport(id);
      return c.json(services.tasks.summary(id));
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
    handle(async (c) => {
      const id = taskId(c);
      const { input, warning } = await integrations.resolveLinkInput(await parseBody(c, LinkInput));
      const link: AddLinkResult = services.links.add(id, input, actorOf(c));
      // A session's status is a local file read; show it now rather than at the next poll.
      if (link.kind === "agent_session") void integrations.refreshLink(link.id).catch(() => {});
      // Likewise a PR: its state is one query away, so don't leave the link blank until the next poll.
      if (link.kind === "pr") integrations.prLinked(link.id);
      return c.json(warning ? { ...link, warning } : link, 201);
    }),
  );
  // The task panel is open: read the task's PRs now if they are stale, and poll them hot while it keeps asking.
  app.post(
    "/api/tasks/:id/view",
    handle(async (c) => {
      await integrations.taskViewed(taskId(c));
      return noContent(c);
    }),
  );
  app.post(
    "/api/tasks/:id/notes",
    handle(async (c) => {
      const { text } = await parseBody(c, z.object({ text: z.string().trim().min(1) }));
      return c.json(services.tasks.addNote(taskId(c), text, actorOf(c)), 201);
    }),
  );
  // The user dismissing an agent's request for attention; returns the task either way.
  app.delete(
    "/api/tasks/:id/attention-request",
    handle((c) => c.json(services.attention.clear(taskId(c), actorOf(c)).task)),
  );
}
