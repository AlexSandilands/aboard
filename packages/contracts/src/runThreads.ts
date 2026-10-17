import type { AutopilotRun } from "./autopilot.ts";
import type { TaskLink, TaskSummary } from "./schemas.ts";

// What the board can tell about a T3 thread an Autopilot run handed work to. A T3 run ends once its thread has
// started (or its nudge was sent), long before the agent is done, so automations (and the PR row's "Autopilot is
// fixing") read the thread's snapshot instead.

/** T3 thread statuses that mean an agent is at work: `waiting` is idle with subagents or monitors still going. */
const BUSY_THREAD = new Set(["working", "waiting", "input", "approval"]);

/**
 * How long a thread counts as working without a snapshot (just started, T3's poll hasn't seen it) or with one the poll
 * hasn't refreshed (T3 is gone, or the thread was deleted). Every live poll refreshes the snapshots of the threads it
 * sees, so a stale one means the board can't see the thread any more.
 */
export const UNSEEN_MS = 10 * 60_000;

type ThreadLink = Extract<TaskLink, { kind: "t3_thread" }>;

/**
 * Whether the T3 thread a finished run began (or nudged) is still working on it: busy, and not settled or archived. A
 * snapshot only counts as evidence when the live poll took it after the run ended: the launch-time poll sees a thread
 * that hasn't run yet ("idle"). Without one, or when the poll stopped refreshing it, the thread counts for ten minutes
 * from the run's end or the snapshot.
 */
export function t3RunWorking(task: Pick<TaskSummary, "links">, run: AutopilotRun, at: number): boolean {
  if (run.status === "running" || run.runner !== "t3" || !run.threadUrl) return false;
  const thread = task.links.find((l): l is ThreadLink => l.kind === "t3_thread" && l.url === run.threadUrl);
  if (!thread) return false;
  const { snapshot } = thread;
  if (snapshot?.archived || snapshot?.settled) return false;
  const endedAt = run.finishedAt ?? run.updatedAt;
  const reported = snapshot && thread.syncedAt !== null && Date.parse(thread.syncedAt) >= Date.parse(endedAt);
  const seenAt = reported ? thread.syncedAt! : endedAt;
  if (at - Date.parse(seenAt) >= UNSEEN_MS) return false;
  return reported ? BUSY_THREAD.has(snapshot.status) : true;
}
