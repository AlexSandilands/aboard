import { randomUUID } from "node:crypto";
import { PrSnapshot } from "@repo/contracts";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app.ts";
import { AppError } from "../../errors.ts";
import { handle, parseBody } from "../respond.ts";

const StartRunInput = z.object({
  automation: z.string().min(1),
  taskId: z.string().min(1),
  summary: z.string().min(1),
});

const FinishRunInput = z.object({
  status: z.enum(["succeeded", "failed", "skipped"]).optional(),
  summary: z.string().optional(),
});

/**
 * /api/demo: stands in for the GitHub poller and the Autopilot engine, which the sandbox turns off, so the README
 * demo (scripts/demo) can show PR checks changing and Autopilot runs without real `gh` calls or paid agent runs.
 * Registered only when the sandbox sets `demo` in the config. Each route makes the service call the poller or the
 * engine makes, so the board shows exactly what a real run shows.
 */
export function registerDemoRoutes(app: Hono, { services }: AppContext): void {
  // Merges the fields given over the PR link's snapshot, as the poller writes it.
  app.post(
    "/api/demo/links/:id/pr",
    handle(async (c) => {
      const patch = await parseBody(c, PrSnapshot.partial());
      const link = services.links.get(c.req.param("id") ?? "");
      if (link.kind !== "pr") throw new AppError("VALIDATION", "Only a PR link has PR checks");
      const before = PrSnapshot.safeParse(link.snapshot);
      if (!before.success) throw new AppError("VALIDATION", "The PR link has no snapshot to change");
      services.links.setSnapshot(link.id, { ...before.data, ...patch });
      return c.json(services.links.get(link.id));
    }),
  );
  // Records a run and starts it at once: the card shows the Autopilot badge until it is finished.
  app.post(
    "/api/demo/autopilot/runs",
    handle(async (c) => {
      const { automation, taskId, summary } = await parseBody(c, StartRunInput);
      const task = services.tasks.summary(services.tasks.resolveId(taskId));
      // With its project, as the engine records it, so the lane's Autopilot pill spins too.
      const run = services.autopilot.record({
        automation,
        candidate: { dedupeKey: `demo:${randomUUID()}`, summary, taskId: task.id, projectId: task.projectId },
        dryRun: false,
      });
      if (!run) throw new AppError("CONFLICT", "The run was already recorded");
      return c.json(services.autopilot.start(run.id), 201);
    }),
  );
  app.post(
    "/api/demo/autopilot/runs/:id/finish",
    handle(async (c) => {
      const result = await parseBody(c, FinishRunInput);
      return c.json(services.autopilot.finish(c.req.param("id") ?? "", result));
    }),
  );
}
