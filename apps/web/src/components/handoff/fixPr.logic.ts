import {
  AUTOPILOT_FIX_PRS,
  fixGaveUpPrefix,
  fixRunKeyPrefix,
  t3RunWorking,
  type AttentionReason,
  type AutopilotRun,
  type PrAutopilotState,
  type TaskSummary,
} from "@repo/contracts";

/**
 * What Fix PRs is doing about a PR, as far as the board can tell, for the PR row's action slot. Null when it is off for
 * the task, or has nothing to say: it hasn't acted yet, or has done all it will, and the user's Fix in → is then the
 * useful button. It is fixing this PR while one of its Fix PRs runs for the link is queued or running, or handed the fix
 * to a T3 thread (a new one, or a nudge into the task's own) that is still working: those runs end at once, long before
 * the agent is done (`t3RunWorking`, as Fix PRs itself waits on them).
 */
export function prAutopilotState(input: {
  /** Fix PRs resolves On for the task's epic, project or the board. */
  fixOn: boolean;
  /** The task's Autopilot runs (newest first), as far as they have loaded. */
  runs: ReadonlyArray<AutopilotRun> | undefined;
  /** The task's links, where a run's T3 thread is. */
  task: Pick<TaskSummary, "links">;
  linkId: string;
  attention: ReadonlyArray<Pick<AttentionReason, "kind" | "message">>;
  /** The PR's number, which a gave-up message names. */
  prNumber: number | undefined;
  /** Now, in ms since the epoch; the clock's by default. */
  at?: number;
}): PrAutopilotState | null {
  if (!input.fixOn) return null;
  const prefix = fixRunKeyPrefix(input.linkId);
  const at = input.at ?? Date.now();
  const working = (input.runs ?? []).some(
    (run) =>
      run.automation === AUTOPILOT_FIX_PRS &&
      !run.dryRun &&
      run.dedupeKey.startsWith(prefix) &&
      (run.status === "queued" || run.status === "running" || t3RunWorking(input.task, run, at)),
  );
  if (working) return "fixing";
  if (input.prNumber !== undefined) {
    const gaveUp = fixGaveUpPrefix(input.prNumber);
    if (input.attention.some((a) => a.kind === "autopilot" && a.message.startsWith(gaveUp))) return "gave_up";
  }
  return null;
}

export const PR_AUTOPILOT_LABEL: Record<PrAutopilotState, string> = {
  fixing: "Autopilot is fixing",
  gave_up: "Autopilot gave up",
};

export const PR_AUTOPILOT_TITLE: Record<PrAutopilotState, string> = {
  fixing: "Autopilot's Fix PRs is working on this pull request",
  gave_up: "Autopilot's Fix PRs gave up on this pull request: see the task's Needs attention",
};
