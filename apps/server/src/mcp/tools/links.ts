import { z } from "zod";
import { AppError } from "../../errors.ts";
import { linkText } from "../format.ts";
import { actorField, run, t3ThreadField, taskField, textResult, type ToolRegistrar } from "../shared.ts";

/** link: attach PRs, Jira keys, T3 threads and URLs. */
export const registerLinkTools: ToolRegistrar = (server, { services, actor }) => {
  server.registerTool(
    "link",
    {
      title: "Link a PR, Jira issue, T3 thread or URL",
      description:
        "Attach a link to a task. Idempotent. `value` may be a GitHub/Azure DevOps/Bitbucket PR URL (GitHub PRs " +
        "show live state: checks, review, conflicts), a Jira key like ABC-123, a t3code:// thread link, or any URL. " +
        "Link the PR as soon as you open it (then move_task to review). Inside T3 Code, pass `t3Thread` " +
        "({environmentId, threadId} from t3_environment_read and t3_thread_configuration) so the user can jump " +
        "back to your thread.",
      inputSchema: {
        task: taskField,
        value: z.string().optional().describe("PR URL, Jira key, t3code:// link or URL."),
        t3Thread: t3ThreadField.optional(),
        label: z.string().optional().describe("Optional display label."),
        actor: actorField,
      },
    },
    (args) =>
      run(() => {
        if (!args.value === !args.t3Thread) throw new AppError("VALIDATION", "Pass exactly one of value or t3Thread.");
        const id = services.tasks.resolveId(args.task);
        const link = services.links.add(
          id,
          {
            ...(args.value ? { value: args.value } : {}),
            ...(args.t3Thread ? { t3Thread: args.t3Thread } : {}),
            ...(args.label ? { label: args.label } : {}),
          },
          actor(args.actor),
        );
        const summary = services.tasks.summary(id);
        return textResult(`Linked to #${summary.number}: ${linkText(link)}`, {
          taskId: id,
          linkId: link.id,
          kind: link.kind,
        });
      }),
  );
};
