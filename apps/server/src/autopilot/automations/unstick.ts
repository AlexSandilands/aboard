import { AUTOPILOT_ACTOR, AUTOPILOT_UNSTICK, type TaskSummary } from "@repo/contracts";
import { z } from "zod";
import { messageOf } from "../../integrations/github.ts";
import { latestThread } from "../../integrations/reviewFallbacks.ts";
import { defineAutomation, type Candidate } from "../types.ts";

export { AUTOPILOT_UNSTICK };

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

const DEFAULT_NUDGE = "Continue, or report what's blocking you.";

interface UnstickData {
  kind: "stale" | "waiting";
  /** How long it has been quiet or waiting, for the messages. */
  ms: number;
}

const duration = (ms: number): string => {
  const minutes = Math.floor(ms / MINUTE_MS);
  return minutes >= 120 ? `${Math.floor(minutes / 60)}h` : `${minutes}m`;
};

/**
 * Flags In Progress tasks that have gone quiet, or whose T3 thread has waited on the user too long, and tells the
 * user. Needs no agent. The optional nudge posts into the task's existing thread and never starts a session, so it
 * doesn't count against the agent caps. Autopilot's own entries aren't activity, or its notes would end the quiet
 * period they report. Dedupe keys carry the moment the quiet period or the wait began, so each is reported once.
 */
export const unstick = defineAutomation({
  key: AUTOPILOT_UNSTICK,
  title: "Unstick stale tasks",
  description:
    "Flags In Progress tasks with no activity, or a T3 thread waiting on you, for too long, and can nudge the thread.",
  needsAgent: false,
  schema: z.object({
    staleHours: z.number().min(1).default(24),
    waitingMinutes: z.number().min(1).default(30),
    nudge: z.boolean().default(false),
    nudgeMessage: z.string().default(DEFAULT_NUDGE),
  }),
  fields: [
    { key: "staleHours", label: "No activity for", kind: "number", min: 1, step: 1, unit: "hours" },
    { key: "waitingMinutes", label: "Thread waiting for", kind: "number", min: 1, step: 5, unit: "minutes" },
    { key: "nudge", label: "Nudge the thread", kind: "boolean" },
    { key: "nudgeMessage", label: "Nudge message", kind: "text", placeholder: DEFAULT_NUDGE },
  ],
  defaults: { staleHours: 24, waitingMinutes: 30, nudge: false, nudgeMessage: DEFAULT_NUDGE },
  check: ({ services, projects, now }) =>
    projects.flatMap(({ project, config }): Candidate[] =>
      services.tasks
        .summaries({ projectId: project.id, status: "in_progress" })
        .filter((t) => t.kind !== "epic")
        .flatMap((t): Candidate[] => {
          const out: Candidate[] = [];
          // Newest first would be cheaper, but the recent window is small and the status change bounds it.
          const lastActivityAt = services.tasks
            .detail(t.id)
            .events.filter((e) => e.actor !== AUTOPILOT_ACTOR)
            .map((e) => e.at)
            .concat(t.statusChangedAt)
            .sort()
            .at(-1)!;
          const quiet = now.getTime() - Date.parse(lastActivityAt);
          if (quiet >= config.staleHours * HOUR_MS) {
            out.push({
              dedupeKey: `stale:${t.id}:${lastActivityAt}`,
              summary: `flag #${t.number}: no activity for ${duration(quiet)}`,
              taskId: t.id,
              data: { kind: "stale", ms: quiet } satisfies UnstickData,
            });
          }
          const thread = latestThread(t);
          const snapshot = thread?.snapshot;
          if (thread && snapshot && ["input", "approval"].includes(snapshot.status) && snapshot.lastActivityAt) {
            const waiting = now.getTime() - Date.parse(snapshot.lastActivityAt);
            if (waiting >= config.waitingMinutes * MINUTE_MS) {
              out.push({
                dedupeKey: `waiting:${thread.id}:${snapshot.lastActivityAt}`,
                summary: `flag #${t.number}: thread waiting for ${duration(waiting)}`,
                taskId: t.id,
                data: { kind: "waiting", ms: waiting } satisfies UnstickData,
              });
            }
          }
          return out;
        }),
    ),
  act: async (candidate, { services, runner, run, config, actor }) => {
    const task: TaskSummary = services.tasks.summary(candidate.taskId!);
    const { kind, ms } = candidate.data as UnstickData;
    const message =
      kind === "stale" ? `Stale: no activity for ${duration(ms)}` : `Thread waiting for input for ${duration(ms)}`;
    services.tasks.addNote(task.id, message, actor);
    services.notifications.notify({
      kind: "autopilot_notice",
      taskId: task.id,
      title: `#${task.number} ${kind === "stale" ? "has gone quiet" : "is waiting for you"}`,
      body: `${message}: “${task.title}”.`,
      dedupeKey: candidate.dedupeKey,
    });
    let nudged = "";
    if (config.nudge) {
      try {
        if (!latestThread(task)) throw new Error("it has no live T3 Code thread");
        await runner.start({
          run,
          prompt: config.nudgeMessage.trim() || DEFAULT_NUDGE,
          tier: null,
          options: config,
          kind: "nudge",
        });
        nudged = "; nudged the thread";
      } catch (error) {
        nudged = `; couldn't nudge: ${messageOf(error)}`;
      }
    }
    return {
      summary: `${message}${nudged}`,
      // A waiting thread already shows its own reason on the card; only a quiet task needs one from us.
      needsAttention: kind === "stale",
    };
  },
});
