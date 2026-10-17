import { AUTOPILOT_FIX_PRS, AUTOPILOT_REVIEW_PRS, fixGaveUpPrefix } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { prAutopilotState } from "./fixPr.logic";

const gaveUp = (number: number) => ({
  kind: "autopilot" as const,
  message: `${fixGaveUpPrefix(number)} 2 fix attempts used, still to fix: failing checks`,
});

describe("prAutopilotState", () => {
  const base = { fixOn: true, activeRun: undefined, attention: [], prNumber: 7 };

  it("says nothing when Fix PRs is off for the task", () => {
    expect(prAutopilotState({ ...base, fixOn: false, activeRun: { automation: AUTOPILOT_FIX_PRS } })).toBeNull();
    expect(prAutopilotState({ ...base, fixOn: false, attention: [gaveUp(7)] })).toBeNull();
  });

  it("says it is fixing while a Fix PRs run is going on the task", () => {
    expect(prAutopilotState({ ...base, activeRun: { automation: AUTOPILOT_FIX_PRS } })).toBe("fixing");
    // Another automation's run says nothing about fixing.
    expect(prAutopilotState({ ...base, activeRun: { automation: AUTOPILOT_REVIEW_PRS } })).toBeNull();
  });

  it("says it gave up from the task's attention reason for this PR", () => {
    expect(prAutopilotState({ ...base, attention: [gaveUp(7)] })).toBe("gave_up");
    expect(prAutopilotState({ ...base, attention: [gaveUp(8)] })).toBeNull();
    // Another reason that happens to start the same is not a PR's: only #7, not #70.
    expect(prAutopilotState({ ...base, attention: [gaveUp(70)] })).toBeNull();
    expect(
      prAutopilotState({ ...base, attention: [{ kind: "pr_checks_failing", message: gaveUp(7).message }] }),
    ).toBeNull();
    expect(prAutopilotState({ ...base, attention: [gaveUp(7)], prNumber: undefined })).toBeNull();
  });

  it("prefers fixing to a gave-up message left from an earlier head", () => {
    expect(prAutopilotState({ ...base, activeRun: { automation: AUTOPILOT_FIX_PRS }, attention: [gaveUp(7)] })).toBe(
      "fixing",
    );
  });
});
