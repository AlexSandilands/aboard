import { AgentHarness, AgentSessionRef } from "@repo/contracts";
import { z } from "zod";
import { AppError } from "../../errors.ts";
import { linkText } from "../format.ts";
import { actorField, run, t3ThreadField, taskField, textResult, type ToolRegistrar } from "../shared.ts";

/** link: attach PRs, Jira keys, T3 threads, agent sessions and URLs. */
export const registerLinkTools: ToolRegistrar = (server, { services, ctx, actor }) => {
  server.registerTool(
    "link",
    {
      title: "Link a PR, Jira issue, T3 thread, agent session or URL",
      description:
        "Attach a link to a task. Idempotent. `value` may be a GitHub/Azure DevOps/Bitbucket PR URL (GitHub PRs " +
        "show live state: checks, review, conflicts), a Jira key like ABC-123, a t3code:// thread link, a T3 thread ID, or any URL. " +
        "Link the Jira issue when the task is created or picked up, and the PR as soon as you open it (then " +
        "move_task to review). Inside T3 Code, pass `t3Thread` ({environmentId, threadId} from " +
        "t3_environment_read and t3_thread_configuration) whenever you start or resume a task, so the user can " +
        "jump back to your thread. In Claude Code or Copilot CLI (inside T3 Code too), also pass `agentSession` " +
        "with your own session when you start or resume a task: the board shows whether it is running and can " +
        'reopen it in a terminal. Give a session a `label` saying what it does ("Implementing #107", "Planning #107", ' +
        '"Reviewing #107 round 2"): the board shows it as the session\'s name, and linking the same session again with a ' +
        "new label renames it. Pass one of value, t3Thread or agentSession per call.",
      inputSchema: {
        task: taskField,
        value: z
          .string()
          .optional()
          .describe(
            'PR URL, Jira key, t3code:// link, T3 thread ID (the full ID T3\'s "Copy thread ID" gives; the board ' +
              "adds the environment and checks the thread exists) or URL.",
          ),
        t3Thread: t3ThreadField.optional(),
        agentSession: z
          .object({
            harness: AgentHarness.describe('"claude-code" or "copilot-cli": the CLI you are running in.'),
            sessionId: z
              .string()
              .describe(
                "Your session id, a UUID: $CLAUDE_CODE_SESSION_ID in Claude Code, $COPILOT_AGENT_SESSION_ID in Copilot " +
                  "CLI. Read it with the shell (echo $CLAUDE_CODE_SESSION_ID); don't guess it.",
              ),
            cwd: z.string().describe("Absolute path of the folder the session runs in (your cwd)."),
          })
          .optional()
          .describe("Your own Claude Code or Copilot CLI session, so the user can reopen it from the board."),
        label: z
          .string()
          .optional()
          .describe(
            'Display label. For agentSession, what this session does: "Implementing #107", "Planning #107", "Reviewing #107 round 2".',
          ),
        actor: actorField,
      },
    },
    (args) =>
      run(async () => {
        if ([args.value, args.t3Thread, args.agentSession].filter(Boolean).length !== 1) {
          throw new AppError("VALIDATION", "Pass exactly one of value, t3Thread or agentSession.");
        }
        const agentSession = args.agentSession ? AgentSessionRef.safeParse(args.agentSession) : null;
        if (agentSession && !agentSession.success) {
          throw new AppError(
            "VALIDATION",
            `agentSession: ${agentSession.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
          );
        }
        const id = services.tasks.resolveId(args.task);
        const { input, warning } = await ctx.integrations.resolveLinkInput({
          ...(args.value ? { value: args.value } : {}),
          ...(args.t3Thread ? { t3Thread: args.t3Thread } : {}),
          ...(agentSession?.success ? { agentSession: agentSession.data } : {}),
          ...(args.label ? { label: args.label } : {}),
        });
        const link = services.links.add(id, input, actor(args.actor));
        // A session's status is a local file read; show it now rather than at the next poll.
        if (link.kind === "agent_session") void ctx.integrations.refreshLink(link.id).catch(() => {});
        const summary = services.tasks.summary(id);
        return textResult(`Linked to #${summary.number}: ${linkText(link)}${warning ? `\nWarning: ${warning}` : ""}`);
      }),
  );
};
