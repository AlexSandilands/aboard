import { describe, expect, it } from "vitest";

import { flagSection, stripFlags } from "./attentionFlags.logic";

describe("stripFlags", () => {
  it("leaves the agent's request and a failed import to their own callouts", () => {
    const kinds = ["agent_request", "session_failed", "import_failed", "pr_conflict"] as const;
    expect(stripFlags(kinds.map((kind) => ({ kind }))).map((r) => r.kind)).toEqual(["session_failed", "pr_conflict"]);
  });
});

describe("flagSection", () => {
  it("names the section a flag comes from", () => {
    expect(flagSection("session_failed")).toBe("Sessions");
    expect(flagSection("pr_checks_failing")).toBe("Links");
    expect(flagSection("blocked_step")).toBe("Plan");
    expect(flagSection("agent_request")).toBeNull();
  });
});
