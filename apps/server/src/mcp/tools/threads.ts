import { createHash } from "node:crypto";
import { z } from "zod";
import {
  defaultHandoffMode,
  handoffModeError,
  T3_RUNTIME_MODES,
  taskHandoffPrompt,
  type HandoffMode,
  type TaskLink,
  type TaskSummary,
} from "@repo/contracts";
import { AppError } from "../../errors.ts";
import type { TaskThreadLaunch } from "../../integrations/t3.ts";
import { linkText } from "../format.ts";
import { actorField, boardUrl, run, t3LaunchBlocker, taskField, textResult, type ToolRegistrar } from "../shared.ts";

type ThreadLink = Extract<TaskLink, { kind: "t3_thread" }>;

/** Thread statuses that mean a session is still on the task, so a second one shouldn't start. */
const BUSY = new Set(["working", "waiting", "input", "approval"]);

/** How long a just-linked thread counts as busy before the live poll has read its status. */
const JUST_STARTED_MS = 2 * 60_000;

/** The task's newest linked thread that is still busy on it, or was linked too recently to know. */
function busyThread(task: TaskSummary, now = Date.now()): ThreadLink | undefined {
  return task.links.findLast(
    (l): l is ThreadLink =>
      l.kind === "t3_thread" &&
      (l.snapshot
        ? !l.snapshot.settled && !l.snapshot.archived && BUSY.has(l.snapshot.status)
        : now - Date.parse(l.createdAt) < JUST_STARTED_MS),
  );
}

/** The thread message_task_thread writes to: the one busy on the task, else the newest that isn't archived. */
function messageTarget(task: TaskSummary): ThreadLink | undefined {
  return (
    busyThread(task) ?? task.links.findLast((l): l is ThreadLink => l.kind === "t3_thread" && !l.snapshot?.archived)
  );
}

/**
 * The same id for every attempt at the task's next thread, as a UUID (v5 layout). T3 de-duplicates launches by it,
 * so a retry after a lost reply, or a second call racing the first, returns the thread instead of starting another.
 * `threadsLinked` counts every thread ever linked, so unlinking one doesn't bring an old id back.
 */
function launchCommandId(task: TaskSummary, threadsLinked: number): string {
  const threads = threadsLinked;
  const hex = createHash("sha1").update(`start_task_thread:${task.id}:${threads}`).digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Failures after which T3 may have started the thread anyway (keepsCommandId on the web side). */
const MAYBE_STARTED = new Set(["unreachable", "protocol-after-send"]);

const sentence = (text: string) => text.replace(/[.\s]+$/, "");

/** A branch name as git allows it, so the value can't be read as an option or a revision expression. */
// oxlint-disable-next-line eslint/no-control-regex -- git refuses control characters in ref names, so must we
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[^\s~^:?*[\\\x00-\x1f\x7f]+(?<![./]|\.lock)$/;

const fallback = (ref: string) =>
  `Start it another way: a subagent with get_handoff_prompt(${ref}, subagent: true), or give the user ` +
  `get_handoff_prompt(${ref}) to paste into a new session.`;

/** What the launch chose, since no dialog showed it to anyone. */
function launchSummary(launch: TaskThreadLaunch): string {
  const access = T3_RUNTIME_MODES.find((m) => m.value === launch.runtimeMode)?.label ?? launch.runtimeMode;
  const where =
    launch.workspace.mode === "new_worktree"
      ? `a new worktree from ${launch.workspace.baseRef}${launch.workspace.startFromOrigin ? " (origin's copy)" : ""}`
      : "the project folder itself, which isn't a git repository: start such tasks one at a time";
  const skipped = launch.suggestionUnavailable
    ? ` (not the suggested model: ${sentence(launch.suggestionUnavailable)})`
    : "";
  return `Model ${launch.modelSelection.model}${skipped}, access ${access}, in ${where}.`;
}

/** T3 Code tools for an orchestrating agent (an epic's, or Autopilot's Orchestrate): start_task_thread and message_task_thread. */
export const registerThreadTools: ToolRegistrar = (server, { services, ctx, actor }) => {
  server.registerTool(
    "start_task_thread",
    {
      title: "Start a task in a new T3 Code thread",
      description:
        "Start a new T3 Code thread working on a task, with the task's hand-off prompt as its first message, and " +
        "link it to the task. Use it when epic_overview (for an epic's tasks) says T3 Code is available. The " +
        "thread starts on T3's default model and access (the task's suggested model for work), in a new git " +
        "worktree branched from baseRef (default: the epic's integration branch when it has one, else the default " +
        "branch), so tasks can run side by side. Calling it " +
        "again after a failure returns the same thread rather than starting a second. Refused when the task already " +
        "has a thread working on it (use message_task_thread), or when T3 Code can't take it.",
      inputSchema: {
        task: taskField,
        mode: z
          .enum(["work", "plan", "orchestrate"])
          .optional()
          .describe("Defaults like get_handoff_prompt: plan for tasks in Backlog or without a plan, else work."),
        baseRef: z
          .string()
          .regex(BRANCH, "Not a branch name")
          .optional()
          .describe("Branch to start the worktree from, e.g. another task's branch when one builds on it."),
        startFromOrigin: z
          .boolean()
          .optional()
          .describe(
            "Branch from origin's copy of baseRef instead of the local branch. Defaults to false with a baseRef, " +
              "else to T3's setting.",
          ),
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
        const blocker = t3LaunchBlocker(ctx, services.projects.get(task.projectId));
        if (blocker) throw new AppError("VALIDATION", `${blocker}. ${fallback(ref)}`);
        const busy = busyThread(task);
        if (busy) {
          const state = busy.snapshot ? `${busy.snapshot.title} (${busy.snapshot.status})` : "just started";
          throw new AppError(
            "CONFLICT",
            `#${task.number} already has a T3 thread on it: ${state}. ` +
              `Send it a message with message_task_thread(${ref}, ...) instead.`,
          );
        }
        const prompt = taskHandoffPrompt({ task, boardUrl: boardUrl(ctx), mode, linkedThread: true });
        let launch: TaskThreadLaunch;
        try {
          launch = await ctx.integrations.launchT3TaskThread(
            task.id,
            {
              prompt,
              commandId: launchCommandId(task, services.links.threadsLinked(task.id)),
              work: mode === "work",
              ...(args.baseRef ? { baseRef: args.baseRef } : {}),
              ...(args.startFromOrigin !== undefined ? { startFromOrigin: args.startFromOrigin } : {}),
              // An integration epic's task starts from origin's copy of its branch, where the tasks before it merged.
              ...(!args.baseRef && task.integrationBranch
                ? { baseRef: task.integrationBranch, startFromOrigin: args.startFromOrigin ?? true }
                : {}),
            },
            actor(args.actor),
          );
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          const t3 = (error.details as { t3?: string } | undefined)?.t3;
          const next =
            t3 && MAYBE_STARTED.has(t3)
              ? `T3 Code may have started the thread anyway. Call start_task_thread(${ref}) again with the same ` +
                "arguments: it returns that thread rather than starting another. Don't start the task another way."
              : fallback(ref);
          throw new AppError(error.code, `${sentence(error.message)}. ${next}`, error.details);
        }
        return textResult(
          `Started #${task.number} in a new T3 Code thread (${mode} prompt) and linked it: ${linkText(launch.link)}\n` +
            `${launchSummary(launch)}\n` +
            `Follow it with ${task.parent ? "epic_overview" : "get_task"}, or message it with message_task_thread(${ref}, ...).`,
        );
      }),
  );

  server.registerTool(
    "message_task_thread",
    {
      title: "Message a task's T3 Code thread",
      description:
        "Send a message into the T3 Code thread working on a task (else its newest one): T3 starts a turn, or " +
        "queues it behind the one running. It arrives marked as coming from the orchestrating agent. Use it to " +
        "answer a blocked step, nudge a stalled thread or redirect a task started with start_task_thread. Only for T3 threads; for a " +
        "session the user started, add_note on the task instead, which it reads on its next get_task.",
      inputSchema: {
        task: taskField,
        text: z.string().trim().min(1).describe("The message, written to the agent working on the task."),
      },
    },
    (args) =>
      run(async () => {
        const task = services.tasks.summary(services.tasks.resolveId(args.task));
        const blocker = t3LaunchBlocker(ctx, services.projects.get(task.projectId));
        if (blocker) throw new AppError("VALIDATION", `${blocker}. Leave the session an add_note on the task instead.`);
        const thread = messageTarget(task);
        if (!thread) {
          throw new AppError(
            "VALIDATION",
            `#${task.number} has no T3 thread linked. Leave the session an add_note on the task instead.`,
          );
        }
        // T3 shows it as the user's own message, so say who really sent it.
        const text = `From an orchestrating agent (sent through the board):\n\n${args.text}`;
        await ctx.integrations.messageT3Thread(thread, text);
        return textResult(`Sent to #${task.number}'s thread: ${linkText(thread)}`);
      }),
  );
};
