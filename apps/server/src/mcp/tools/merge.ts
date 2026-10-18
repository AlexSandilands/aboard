import { MergeMethod } from "@repo/contracts";
import { actorField, run, taskField, taskResult, type ToolRegistrar } from "../shared.ts";

/** merge_task_pr: the one way an agent merges into the default branch (docs/features/github-prs.md#merge_task_pr). */
export const registerMergeTools: ToolRegistrar = (server, { services, ctx, actor }) => {
  server.registerTool(
    "merge_task_pr",
    {
      title: "Merge a task's pull request into the default branch",
      description:
        "Merge the one open pull request linked to a task into the repository's default branch, then move the task to " +
        "Done. Only for a task the user flagged for auto-merge (update_task autoMerge: on, set only once the user has " +
        "said so). The board refuses, with the reason, unless the task is in Review and its PR is open, targets the " +
        "default branch, has no local review still going or blocking/major findings open, no Autopilot review or fix " +
        "running and none of Autopilot's review points left to fix, no changes requested, checks passing, and merges " +
        "cleanly. A refusal is not an error to work around: fix what it names, wait, or leave the merge to the user. " +
        "Never merge with gh or git instead. You choose which task's PR to merge and when: merge one at a time and let " +
        "the others catch up, so they don't conflict. method defaults to one the repository allows.",
      inputSchema: {
        task: taskField,
        method: MergeMethod.optional().describe("squash, merge or rebase. Omit it to use one the repository allows."),
        actor: actorField,
      },
    },
    (args) =>
      run(async () => {
        const merged = await ctx.integrations.mergeTaskPr(
          services.tasks.resolveId(args.task),
          { method: args.method },
          actor(args.actor),
        );
        return taskResult(
          services,
          merged.task.id,
          `Merged PR #${merged.number} (${merged.url}) into ${merged.base} with a ${merged.method} merge.`,
          { closing: true },
        );
      }),
  );
};
