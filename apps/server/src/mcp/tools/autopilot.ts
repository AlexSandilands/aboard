import { canRetryRun } from "@repo/contracts";
import { z } from "zod";
import { AppError } from "../../errors.ts";
import { actorField, run, taskField, taskResult, type ToolRegistrar } from "../shared.ts";

/**
 * retry_autopilot_run: the one Autopilot tool agents get. It lifts no limit (the engine decides whether there is still
 * work, under the user's switches, pause and caps), so it is safe to hand to an orchestrator.
 */
export const registerAutopilotTools: ToolRegistrar = (server, { services, actor }) => {
  server.registerTool(
    "retry_autopilot_run",
    {
      title: "Retry a task's failed Autopilot run",
      description:
        "Let Autopilot try a task's failed or skipped run again, such as a PR review or a start that a board restart " +
        "interrupted (get_task shows it under attention or in recent activity). Clears its attention flag; on its next " +
        "pass, within a minute, the automation acts again if there is still work, under the user's switches, pause and " +
        "limits. Rounds and attempts no longer count the retried run. Use it instead of pushing an empty commit to " +
        "re-trigger a review. Retry a run once its cause is gone: one that fails the same way again wastes a run.",
      inputSchema: {
        task: taskField,
        automation: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Which automation's run, by key or title (e.g. review_prs or Review PRs). Default: the task's newest run that can be retried.",
          ),
        actor: actorField,
      },
    },
    (args) =>
      run(() => {
        const taskId = services.tasks.resolveId(args.task);
        const titles = new Map(services.autopilot.automations().map((a) => [a.key, a.title]));
        const wanted = args.automation?.toLowerCase();
        const runs = services.autopilot
          .runsForTask(taskId)
          .filter((r) => !r.dryRun)
          .filter((r) => !wanted || r.automation === wanted || titles.get(r.automation)?.toLowerCase() === wanted);
        // Newest first. A run the same automation has run again since (its next head, its next try) is history: retrying
        // it would redo superseded work and use up another round.
        const target = runs.find(
          (r, i) => canRetryRun(r) && !runs.slice(0, i).some((n) => n.automation === r.automation),
        );
        if (!target) {
          const which = args.automation ? `${args.automation} ` : "";
          throw new AppError("NOT_FOUND", `This task has no failed or skipped ${which}Autopilot run to retry.`);
        }
        const retried = services.autopilot.retry(target.id, actor(args.actor));
        const title = titles.get(retried.automation) ?? retried.automation;
        return taskResult(
          services,
          taskId,
          `Asked ${title} to try again (${target.summary}). Its next pass acts if there is still work; ` +
            "follow it in the task's activity.",
        );
      }),
  );
};
