import { ResolveFindingInput, reviewFixInstructions, reviewLoopInstructions } from "@repo/contracts";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app.ts";
import { headlessCliVersion } from "../../integrations/headlessReview.ts";
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

  /**
   * A prompt for pasting into any harness: fix the open findings when the latest round has blocking or major
   * ones, otherwise run the loop for the open round (or the next one).
   */
  app.get(
    "/api/tasks/:id/review-prompt",
    handle((c) => {
      const id = taskId(c);
      const task = services.tasks.summary(id);
      const latest = services.reviews.list(id).at(-1);
      const maxRounds = services.settings.get().reviewMaxRounds;
      const gating = task.review ? task.review.open.blocking + task.review.open.major : 0;
      // The summary counts the current cycle's rounds; the limit is per cycle.
      const cycleRounds = task.review?.round ?? 0;
      if (latest?.status === "submitted" && gating > 0) {
        return c.json({
          prompt: reviewFixInstructions({ task, round: latest.round, cycleRound: cycleRounds, maxRounds }),
        });
      }
      const open = latest && latest.status !== "submitted";
      return c.json({
        prompt: reviewLoopInstructions({
          task,
          round: open ? latest.round : (latest?.round ?? 0) + 1,
          cycleRound: open ? cycleRounds : cycleRounds + 1,
          maxRounds,
          skill: services.reviews.skillFor(id),
        }),
      });
    }),
  );

  /** Checks the configured Claude Code CLI for the board reviewer: its path and version. */
  app.post(
    "/api/review/test-cli",
    handle(async (c) => {
      const { cli } = await parseBody(c, z.object({ cli: z.string().trim().nullable().optional() }));
      try {
        return c.json({ ok: true, ...(await headlessCliVersion(cli ?? services.settings.get().headlessReviewCli)) });
      } catch (error) {
        return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
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
