import {
  AGENT_HARNESSES,
  AgentHarness,
  AgentSessionRef,
  EARLY_PR_NEXT,
  prWaitsForLocalReview,
  SELF_LINK_ENV_RULE,
  SELF_LINK_FAILED,
  SELF_LINK_OTHER_HOST,
  SELF_LINK_SUBAGENT,
  SELF_LINK_WHEN,
  selfLinkHostLine,
} from "@repo/contracts";
import { z } from "zod";
import { AppError } from "../../errors.ts";
import { linkText } from "../format.ts";
import { actorField, run, t3ThreadField, taskField, textResult, type ToolRegistrar } from "../shared.ts";

/** link: attach PRs, ticket keys, T3 threads, agent sessions and URLs; unlink: take one off again. */
export const registerLinkTools: ToolRegistrar = (server, { services, ctx, actor }) => {
  server.registerTool(
    "link",
    {
      title: "Link a PR, ticket, T3 thread, agent session or URL",
      description:
        "Attach a link to a task. Idempotent. `value` may be a GitHub/Azure DevOps/Bitbucket PR URL (GitHub PRs " +
        "show live state: checks, review, conflicts), a ticket key or URL from a ticket system the board is set up " +
        "for, a t3code:// thread link, a T3 thread ID, or any URL. " +
        "Link the task's ticket when the task is created or picked up, and the PR once you have opened it: with " +
        "auto-review on that is after the local review loop ends (move_task to review and finish the loop first; " +
        "Autopilot's PR review waits for it, and a PR opened earlier is reviewed on GitHub too), otherwise before " +
        `move_task to review. ${SELF_LINK_WHEN} ${selfLinkHostLine("t3-code", null, "")} It lets the user jump back to ` +
        "your thread; `t3Thread` ({environmentId, threadId}) still works too. In Claude Code, Codex or Copilot CLI " +
        "(inside T3 Code too), also pass `agentSession` with your own session: the board can reopen it in a terminal and, for " +
        'Claude Code and Copilot CLI, shows whether it is running. Give a session a `label` saying what it does ("Implementing #107", "Planning #107", or "Orchestrating #107" for an epic you run): ' +
        `the board shows it as the session's name, and linking the same session again with a new label renames it. ${SELF_LINK_SUBAGENT} ` +
        `${SELF_LINK_ENV_RULE} ${SELF_LINK_OTHER_HOST} ${SELF_LINK_FAILED} Pass one of value, t3Thread or agentSession per call.`,
      inputSchema: {
        task: taskField,
        value: z
          .string()
          .optional()
          .describe(
            'PR URL, ticket key or URL, t3code:// link, T3 thread ID (the full ID T3\'s "Copy thread ID" gives; the board ' +
              "adds the environment and checks the thread exists) or URL.",
          ),
        t3Thread: t3ThreadField.optional(),
        agentSession: z
          .object({
            harness: AgentHarness.describe('"claude-code", "codex" or "copilot-cli": the CLI you are running in.'),
            sessionId: z.string().describe(
              `Your session id, a UUID: ${Object.values(AGENT_HARNESSES)
                .map((h) => `$${h.idEnvVar} in ${h.label}`)
                .join(", ")}. Read that one variable with the shell; don't guess it.`,
            ),
            cwd: z.string().describe("Absolute path of the folder the session runs in (your cwd)."),
          })
          .optional()
          .describe("Your own Claude Code, Codex or Copilot CLI session, so the user can reopen it from the board."),
        label: z
          .string()
          .optional()
          .describe(
            'Display label. For agentSession, what this session does: "Implementing #107", "Planning #107", or "Orchestrating #107" for an epic.',
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
        if (link.kind === "pr") ctx.integrations.prLinked(link.id);
        const summary = services.tasks.summary(id);
        // A PR linked before the loop ended is reviewed on GitHub too once the task reaches Review; say so, but link anyway.
        const early =
          link.kind === "pr" &&
          summary.status !== "done" &&
          prWaitsForLocalReview(summary.status, summary.review, services.reviews.effectiveAutoReview(id));
        return textResult(
          `Linked to #${summary.number}: ${linkText(link, services.settings.get().ticketSystems)}${warning ? `\nWarning: ${warning}` : ""}` +
            (early
              ? `\nNote: local review is on for this task, so this PR was opened before the review loop ended. ${EARLY_PR_NEXT}`
              : ""),
        );
      }),
  );

  server.registerTool(
    "unlink",
    {
      title: "Remove a link from a task",
      description:
        "Remove a link from a task that is wrong, such as a ticket key the board linked from the title that is not a " +
        "ticket, or a PR you linked by mistake. `value` is what `link` takes (a PR or ticket URL, or a ticket key), or " +
        "the link's id. It is refused when the task has no such link. Only remove links that are wrong: a ticket or " +
        "PR the task really belongs to stays.",
      inputSchema: {
        task: taskField,
        value: z.string().describe("The link's URL or ticket key, as shown on the task, or its link id."),
        actor: actorField,
      },
    },
    (args) =>
      run(() => {
        const id = services.tasks.resolveId(args.task);
        const link = services.links.unlink(id, args.value, actor(args.actor));
        const summary = services.tasks.summary(id);
        return textResult(`Unlinked from #${summary.number}: ${linkText(link, services.settings.get().ticketSystems)}`);
      }),
  );
};
