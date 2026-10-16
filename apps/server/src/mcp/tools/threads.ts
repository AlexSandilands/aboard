import { z } from "zod";
import {
  defaultHandoffMode,
  handoffModeError,
  taskHandoffPrompt,
  type HandoffMode,
  type TaskLink,
  type TaskSummary,
} from "@repo/contracts";
import { AppError } from "../../errors.ts";
import { linkText } from "../format.ts";
import { actorField, boardUrl, run, t3LaunchBlocker, taskField, textResult, type ToolRegistrar } from "../shared.ts";

type ThreadLink = Extract<TaskLink, { kind: "t3_thread" }>;

/** Thread statuses that mean a session is still on the task, so a second one shouldn't start. */
const BUSY = new Set(["working", "waiting", "input", "approval"]);

/** The task's newest linked thread that is still busy on it, if any. */
function busyThread(task: TaskSummary): ThreadLink | undefined {
  return task.links
    .filter((l): l is ThreadLink => l.kind === "t3_thread")
    .findLast((l) => l.snapshot && !l.snapshot.settled && !l.snapshot.archived && BUSY.has(l.snapshot.status));
}

/** The thread message_task_thread writes to: the one busy on the task, else the newest that isn't archived. */
function messageTarget(task: TaskSummary): ThreadLink | undefined {
  return (
    busyThread(task) ?? task.links.findLast((l): l is ThreadLink => l.kind === "t3_thread" && !l.snapshot?.archived)
  );
}

const fallback = (ref: string) =>
  `Start it another way: a subagent with get_handoff_prompt(${ref}, subagent: true), or give the user ` +
  `get_handoff_prompt(${ref}) to paste into a new session.`;

/** T3 Code tools for an epic's orchestrator: start_task_thread and message_task_thread. */
export const registerThreadTools: ToolRegistrar = (server, { services, ctx, actor }) => {
  server.registerTool(
    "start_task_thread",
    {
      title: "Start a task in a new T3 Code thread",
      description:
        "Start a new T3 Code thread working on a task, with the task's hand-off prompt as its first message, and " +
        "link it to the task. Use it to start an epic's tasks when epic_overview says T3 Code is available. The " +
        "thread starts on T3's defaults (the task's suggested model for work), in a new git worktree branched from " +
        "baseRef (default: the default branch), so tasks can run side by side. Refused when the task already has a " +
        "thread working on it (use message_task_thread) or T3 Code can't take it.",
      inputSchema: {
        task: taskField,
        mode: z
          .enum(["work", "plan", "orchestrate"])
          .optional()
          .describe("Defaults like get_handoff_prompt: plan for tasks in Backlog or without a plan, else work."),
        baseRef: z
          .string()
          .min(1)
          .optional()
          .describe("Branch to start the worktree from, e.g. another task's branch when one builds on it."),
        startFromOrigin: z
          .boolean()
          .optional()
          .describe("Branch from origin's copy of baseRef. Defaults to T3's setting; pass false for a local branch."),
        actor: actorField,
      },
    },
    (args) =>
      run(async () => {
        const task = services.tasks.summary(services.tasks.resolveId(args.task));
        const ref = `"#${task.number}"`;
        const mode: HandoffMode = args.mode ?? defaultHandoffMode(task);
        const problem = handoffModeError(task, mode);
        if (problem) throw new AppError("VALIDATION", problem);
        const busy = busyThread(task);
        if (busy?.snapshot) {
          throw new AppError(
            "CONFLICT",
            `#${task.number} already has a T3 thread on it: ${busy.snapshot.title} (${busy.snapshot.status}). ` +
              `Send it a message with message_task_thread(${ref}, ...) instead.`,
          );
        }
        const blocker = t3LaunchBlocker(ctx, services.projects.get(task.projectId));
        if (blocker) throw new AppError("VALIDATION", `${blocker}. ${fallback(ref)}`);
        const prompt = taskHandoffPrompt({ task, boardUrl: boardUrl(ctx), mode, linkedThread: true });
        let link: TaskLink;
        try {
          link = await ctx.integrations.launchT3TaskThread(
            task.id,
            {
              prompt,
              work: mode === "work",
              ...(args.baseRef ? { baseRef: args.baseRef } : {}),
              ...(args.startFromOrigin !== undefined ? { startFromOrigin: args.startFromOrigin } : {}),
            },
            actor(args.actor),
          );
        } catch (error) {
          if (error instanceof AppError) throw new AppError(error.code, `${error.message}. ${fallback(ref)}`);
          throw error;
        }
        return textResult(
          `Started #${task.number} in a new T3 Code thread (${mode} prompt) and linked it: ${linkText(link)}\n` +
            `Follow it with epic_overview, or message it with message_task_thread(${ref}, ...).`,
        );
      }),
  );

  server.registerTool(
    "message_task_thread",
    {
      title: "Message a task's T3 Code thread",
      description:
        "Send a message into the T3 Code thread working on a task (else its newest one), as if the user had typed it: T3 starts a " +
        "turn, or queues it behind the one running. Use it to answer a blocked step or redirect a task an " +
        "orchestrator started with start_task_thread. Only for T3 threads; for a session the user started, " +
        "add_note on the task instead, which it reads on its next get_task.",
      inputSchema: {
        task: taskField,
        text: z.string().trim().min(1).describe("The message, written to the agent working on the task."),
      },
    },
    (args) =>
      run(async () => {
        const task = services.tasks.summary(services.tasks.resolveId(args.task));
        const thread = messageTarget(task);
        if (!thread) {
          throw new AppError(
            "VALIDATION",
            `#${task.number} has no T3 thread linked. Leave the session an add_note on the task instead.`,
          );
        }
        await ctx.integrations.messageT3Thread(thread, args.text);
        return textResult(`Sent to #${task.number}'s thread: ${linkText(thread)}`);
      }),
  );
};
