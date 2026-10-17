import {
  AUTOPILOT_FIX_PRS,
  fixGaveUpPrefix,
  type AttentionReason,
  type AutopilotActiveRun,
  type PrAutopilotState,
} from "@repo/contracts";

/**
 * What Fix PRs is doing about a PR, as far as the board can tell, for the PR row's action slot. Null when it is off for
 * the task, or has nothing to say: it hasn't acted yet, or has done all it will, and the user's Fix in → is then the
 * useful button. A run in flight on the task counts (a nudge or a T3 thread ends its run at once, but shows as the
 * thread working).
 */
export function prAutopilotState(input: {
  /** Fix PRs resolves On for the task's epic, project or the board. */
  fixOn: boolean;
  activeRun: Pick<AutopilotActiveRun, "automation"> | undefined;
  attention: ReadonlyArray<Pick<AttentionReason, "kind" | "message">>;
  /** The PR's number, which a gave-up message names. */
  prNumber: number | undefined;
}): PrAutopilotState | null {
  if (!input.fixOn) return null;
  if (input.activeRun?.automation === AUTOPILOT_FIX_PRS) return "fixing";
  if (input.prNumber !== undefined) {
    const prefix = fixGaveUpPrefix(input.prNumber);
    if (input.attention.some((a) => a.kind === "autopilot" && a.message.startsWith(prefix))) return "gave_up";
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
