import { UNSEEN_MS, type TaskLink } from "@repo/contracts";

// What the board can tell about a T3 thread an Autopilot run handed work to is in `t3RunWorking`
// (packages/contracts/src/runThreads.ts), shared with the PR row's Autopilot state.

type ThreadLink = Extract<TaskLink, { kind: "t3_thread" }>;

/** Whether the live poll has seen the thread lately, so T3 Code is there to take a message for it. */
export const threadSeen = (thread: ThreadLink, at: number): boolean =>
  thread.syncedAt !== null && at - Date.parse(thread.syncedAt) < UNSEEN_MS;
