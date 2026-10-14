import { ResolveFindingInput, reviewLoopInstructions } from "@repo/contracts";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app.ts";
import { discoverSkills } from "../../skills.ts";
import { actorOf, handle, idParam, parseBody, parseQuery } from "../respond.ts";

/** Local review: rounds, findings, the review prompt and the skills a reviewer can follow. */
export function registerReviewRoutes(app: Hono, { services, config }: AppContext): void {
  const taskId = (c: Context) => services.tasks.resolveId(idParam(c));

  app.get(
    "/api/skills",
    handle((c) => {
      const { projectId } = parseQuery(c, z.object({ projectId: z.string().optional() }));
      const workspaceRoot = projectId ? services.projects.get(projectId).workspaceRoot : null;
      return c.json(discoverSkills({ homeDir: config.userHome, workspaceRoot }));
    }),
  );

  app.get(
    "/api/tasks/:id/reviews",
    handle((c) => c.json(services.reviews.list(taskId(c)))),
  );

  // The user's explicit request, so it may go past the round limit.
  app.post(
    "/api/tasks/:id/reviews",
    handle((c) =>
      c.json(services.reviews.openRound(taskId(c), { trigger: "manual", actor: actorOf(c), force: true }), 201),
    ),
  );

  /** The loop instructions for pasting into any harness, for the latest round (or the next one). */
  app.get(
    "/api/tasks/:id/review-prompt",
    handle((c) => {
      const id = taskId(c);
      const task = services.tasks.summary(id);
      const latest = services.reviews.list(id).at(-1);
      const round = latest && latest.status !== "submitted" ? latest.round : (latest?.round ?? 0) + 1;
      return c.json({
        prompt: reviewLoopInstructions({
          task,
          round,
          maxRounds: services.settings.get().reviewMaxRounds,
          skill: services.reviews.skillFor(id),
        }),
      });
    }),
  );

  app.patch(
    "/api/tasks/:id/findings/:finding",
    handle(async (c) =>
      c.json(
        services.reviews.resolveFinding(
          taskId(c),
          c.req.param("finding") ?? "",
          await parseBody(c, ResolveFindingInput),
          actorOf(c),
        ),
      ),
    ),
  );
}
