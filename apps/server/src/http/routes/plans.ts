import { PlanStepInput, StepPatch } from "@taskboard/contracts";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app.ts";
import { actorOf, handle, noContent, parseBody, idParam } from "../respond.ts";

const MoveStepInput = z.object({
  phaseId: z.string().optional(),
  beforeId: z.string().nullable().optional(),
  afterId: z.string().nullable().optional(),
});

/** /api/phases and /api/steps — plan edits addressed by phase or step id. */
export function registerPlanRoutes(app: Hono, { services }: AppContext): void {
  app.patch(
    "/api/phases/:id",
    handle(async (c) => {
      const patch = await parseBody(c, z.object({ title: z.string().trim().min(1) }));
      return c.json(services.plans.updatePhase(idParam(c), patch, actorOf(c)));
    }),
  );
  app.delete(
    "/api/phases/:id",
    handle((c) => {
      services.plans.deletePhase(idParam(c), actorOf(c));
      return noContent(c);
    }),
  );
  app.post(
    "/api/phases/:id/steps",
    handle(async (c) => {
      const body = await parseBody(c, z.object({ steps: z.array(PlanStepInput).min(1), afterStepId: z.string().optional() }));
      const steps = services.plans.addSteps(idParam(c), body.steps, actorOf(c), { afterStepId: body.afterStepId });
      return c.json(steps, 201);
    }),
  );
  app.patch(
    "/api/steps/:id",
    handle(async (c) => c.json(services.plans.updateStep(idParam(c), await parseBody(c, StepPatch), actorOf(c)))),
  );
  app.post(
    "/api/steps/:id/move",
    handle(async (c) => c.json(services.plans.moveStep(idParam(c), await parseBody(c, MoveStepInput), actorOf(c)))),
  );
  app.delete(
    "/api/steps/:id",
    handle((c) => {
      services.plans.deleteStep(idParam(c), actorOf(c));
      return noContent(c);
    }),
  );
}
