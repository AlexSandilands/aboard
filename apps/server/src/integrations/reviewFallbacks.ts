import {
  BOARD_REVIEWER,
  REVIEW_DONE_NEXT,
  reviewFixInstructions,
  reviewIsDone,
  reviewLoopInstructions,
  resolveHeadlessModel,
  type TaskLink,
  type TaskSummary,
} from "@repo/contracts";
import type { ReviewRecord } from "../db/repos/reviews.ts";
import { AppError } from "../errors.ts";
import { renderTaskDetail } from "../mcp/format.ts";
import type { Services } from "../services/types.ts";
import { messageOf } from "./github.ts";
import { headlessPrompt, runHeadlessReview, type RunHeadless } from "./headlessReview.ts";
import type { T3Integration, ThreadLink } from "./t3.ts";
import type { Logger } from "./util.ts";

/** How long a nudged thread (or a round the user opened and a thread then took) gets before the next fallback. */
export const REVIEW_GRACE_MS = 10 * 60_000;
/** How long a round an agent opened gets, from the task's last activity: its reviewer reports only at the end. */
export const AGENT_REVIEW_GRACE_MS = 30 * 60_000;
export const REVIEW_WATCHDOG_INTERVAL_MS = 30_000;

/** Thread states where the agent is busy (or waiting on the user), so its review may still come. */
const BUSY = new Set(["working", "input", "approval"]);

export interface ReviewFallbacks {
  /** One pass over pending rounds; resolves when any nudge is sent (not when a headless review ends). */
  tick(): Promise<void>;
  /** Resolves when the headless review in flight, if any, has finished. */
  idle(): Promise<void>;
  start(): void;
  stop(): void;
}

/** The task's most recently linked T3 thread that isn't archived. */
export function latestThread(task: TaskSummary): ThreadLink | null {
  const threads = task.links.filter(
    (l): l is Extract<TaskLink, { kind: "t3_thread" }> => l.kind === "t3_thread" && !l.snapshot?.archived,
  );
  return threads.at(-1) ?? null;
}

/**
 * Picks up review rounds no agent ran: first asks the task's T3 thread to run the loop, then (if enabled)
 * reviews with the board's own headless reviewer, else marks the round stalled so the card asks for help.
 * Rounds the user opened (a card dragged to Review, Run review) skip the first wait.
 */
export function createReviewFallbacks(deps: {
  services: () => Services;
  t3: Pick<T3Integration, "sendToThread" | "threadWorkspace">;
  runHeadless?: RunHeadless;
  now?: () => number;
  graceMs?: number;
  agentGraceMs?: number;
  log?: Logger;
}): ReviewFallbacks {
  const runHeadless = deps.runHeadless ?? runHeadlessReview;
  const now = deps.now ?? Date.now;
  const grace = deps.graceMs ?? REVIEW_GRACE_MS;
  const agentGrace = deps.agentGraceMs ?? AGENT_REVIEW_GRACE_MS;
  const log = deps.log ?? console;
  let headless: Promise<void> | null = null;
  let ticking: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  /** Whether the round is still waiting for a reviewer: an agent may have submitted since the pass began. */
  const stillPending = (round: ReviewRecord): boolean =>
    deps
      .services()
      .reviews.list(round.taskId)
      .find((r) => r.id === round.id)?.status === "pending";

  const nudge = async (round: ReviewRecord, task: TaskSummary, thread: ThreadLink): Promise<boolean> => {
    const s = deps.services();
    const text = reviewLoopInstructions({
      task,
      round: round.round,
      cycleRound: task.review?.round ?? 1,
      maxRounds: s.settings.get().reviewMaxRounds,
      skill: s.reviews.skillFor(task.id),
    });
    try {
      // Stable per round, so a retry after a lost reply doesn't post twice.
      await deps.t3.sendToThread(thread, text, `review-${round.id}-nudge`);
      s.reviews.markNudged(round.id, BOARD_REVIEWER);
      return true;
    } catch (error) {
      log.warn(`[review] couldn't nudge the T3 thread of #${task.number}: ${messageOf(error)}`);
      return false;
    }
  };

  const reviewHeadless = async (round: ReviewRecord, task: TaskSummary, thread: ThreadLink | null) => {
    const s = deps.services();
    // Claim the round only if nobody reviewed it in the meantime.
    if (!s.reviews.setRoundStatus(round.id, "running", { actor: BOARD_REVIEWER, from: ["pending"] })) return;
    try {
      const project = s.projects.get(task.projectId);
      const workspace = thread ? await deps.t3.threadWorkspace(thread) : null;
      const cwd = workspace?.worktreePath ?? project.workspaceRoot;
      if (!cwd) throw new Error(`${project.title} has no workspace folder to review in`);
      const settings = s.settings.get();
      const result = await runHeadless({
        cli: settings.headlessReviewCli,
        cwd,
        budgetUsd: settings.headlessReviewBudgetUsd,
        model: resolveHeadlessModel(settings.modelTiers, settings.headlessReviewModel),
        prompt: headlessPrompt({
          taskNumber: task.number,
          round: round.round,
          taskText: renderTaskDetail(s.tasks.detail(task.id), project, { events: 0 }),
          skill: s.reviews.skillFor(task.id),
          baseRef: null,
        }),
      });
      const cost = result.costUsd === null ? "" : ` (board review, $${result.costUsd.toFixed(2)})`;
      try {
        s.reviews.submit(
          task.id,
          { round: round.round, summary: `${result.summary}${cost}`, findings: result.findings },
          BOARD_REVIEWER,
        );
      } catch (error) {
        // An agent's reviewer submitted while this one ran: its review stands, this one is dropped.
        if (error instanceof AppError && error.code === "CONFLICT") return;
        throw error;
      }
      // Nobody is looping on this round, so tell the thread's agent what to do next, if there is one: fix
      // the findings, or, when the loop is over, open the PR (the idle agent would never read the board).
      if (!thread) return;
      const after = s.tasks.summary(task.id);
      let text: string | null = null;
      let key = `review-${round.id}-fix`;
      // Judged on everything open, not just this round: a gating finding left from an earlier round still needs fixing.
      if (after.review && after.review.open.blocking + after.review.open.major > 0) {
        text = reviewFixInstructions({
          task,
          round: round.round,
          cycleRound: after.review?.round ?? 1,
          maxRounds: settings.reviewMaxRounds,
        });
      } else if (reviewIsDone(after.review) && !after.links.some((l) => l.kind === "pr")) {
        text = `Review round ${round.round} of task #${task.number} "${task.title}" came back clean. ${REVIEW_DONE_NEXT}`;
        key = `review-${round.id}-done`;
      }
      if (text) {
        await deps.t3.sendToThread(thread, text, key).catch((error: unknown) => {
          log.warn(`[review] couldn't send to the T3 thread of #${task.number}: ${messageOf(error)}`);
        });
      }
    } catch (error) {
      s.reviews.setRoundStatus(round.id, "failed", {
        actor: BOARD_REVIEWER,
        error: messageOf(error),
        from: ["running"],
      });
    }
  };

  const consider = async (round: ReviewRecord): Promise<void> => {
    const s = deps.services();
    const task = s.tasks.summary(round.taskId);
    if (task.status !== "review" || task.archivedAt) return;
    const thread = latestThread(task);
    if (thread?.snapshot && BUSY.has(thread.snapshot.status)) return;
    const userAsked = round.openedBy === "user" && !round.nudgedAt;
    if (!userAsked) {
      // An agent's reviewer only reports when it submits, so give it longer, and count any activity on the
      // task (the implementer updating steps, notes) as a sign the loop is still going.
      const since = Math.max(Date.parse(round.nudgedAt ?? round.updatedAt), Date.parse(task.updatedAt));
      const wait = round.openedBy === "user" || round.nudgedAt ? grace : agentGrace;
      if (now() - since < wait) return;
    }
    if (!round.nudgedAt && thread && stillPending(round) && (await nudge(round, task, thread))) return;
    if (s.settings.get().headlessReviewEnabled) {
      // One board review at a time; the rest wait for the next tick.
      headless ??= reviewHeadless(round, task, thread).finally(() => {
        headless = null;
      });
      return;
    }
    s.reviews.setRoundStatus(round.id, "stalled", {
      actor: BOARD_REVIEWER,
      error: thread ? "The task's T3 thread didn't run the review" : "No agent ran the review",
      from: ["pending"],
    });
  };

  const pass = async (): Promise<void> => {
    for (const round of deps.services().reviews.roundsWithStatus("pending")) {
      await consider(round).catch((error: unknown) => {
        log.warn(`[review] fallback for round ${round.round} failed: ${messageOf(error)}`);
      });
    }
  };

  const tick = (): Promise<void> => {
    // Cleared in .finally, never inside the pass: a pass with nothing to await settles synchronously, and a
    // `finally` there would run before this assignment and leave every later tick returning the stale promise.
    ticking ??= pass().finally(() => {
      ticking = null;
    });
    return ticking;
  };

  return {
    tick,
    idle: () => headless ?? Promise.resolve(),
    start() {
      // A board review interrupted by a restart left its round running; let the chain pick it up again.
      const s = deps.services();
      for (const round of s.reviews.roundsWithStatus("running")) {
        s.reviews.setRoundStatus(round.id, "pending", {
          actor: BOARD_REVIEWER,
          error: "The board restarted mid-review",
          from: ["running"],
        });
      }
      timer ??= setInterval(() => void tick(), REVIEW_WATCHDOG_INTERVAL_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
