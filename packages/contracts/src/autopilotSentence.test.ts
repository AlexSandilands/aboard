import { describe, expect, it } from "vitest";
import { DEFAULT_AUTOPILOT_ENGINE, fieldTier, splitFieldsByTier } from "./autopilot.ts";
import { automationSentence, limitsSummary, todaySummary } from "./autopilotSentence.ts";
import type { CustomDefinition } from "./customAutomations.ts";

const say = (key: string, config: Record<string, unknown> = {}) =>
  automationSentence({ key, description: "fallback" }, config);

describe("automationSentence", () => {
  it("reads a built-in's config", () => {
    expect(say("auto_archive", { days: 30 })).toBe(
      "Archive tasks that have been in Done for 30 days, and finished epics with their tasks.",
    );
    expect(say("digest", { mode: "summarised", time: "08:30", weekdaysOnly: true })).toBe(
      "Every weekday at 08:30, write an agent's summary of what changed on the board.",
    );
    expect(say("orchestrate", { everyMinutes: 15, mayMerge: false })).toContain("Every 15 minutes");
    expect(say("orchestrate", { everyMinutes: 15, mayMerge: false })).not.toContain("merges");
    expect(say("review_prs", { skill: { source: "global", name: "security-review" } })).toContain(
      "with the security-review skill",
    );
    expect(say("review_prs")).toContain("up to 3 rounds per PR");
    expect(say("review_prs", { rounds: 1 })).toContain("up to 1 round per PR");
    expect(say("start_planned", { skill: { source: "builtin" } })).toContain("following the default workflow");
  });

  it("lists only the triggers Fix PRs reacts to, and says when none is on", () => {
    expect(
      say("fix_prs", {
        onChecks: true,
        onConflicts: true,
        onChangesRequested: false,
        onComments: false,
        onAutopilotReview: false,
      }),
    ).toBe("When a task's PR has failing checks and conflicts, send an agent to fix it.");
    expect(
      say("fix_prs", {
        onChecks: false,
        onConflicts: false,
        onChangesRequested: false,
        onComments: false,
        onAutopilotReview: false,
      }),
    ).toBe("Every trigger is off, so it never fixes anything.");
    expect(say("fix_prs", { onChecks: false, onConflicts: false, fixThreshold: "minor" })).toContain(
      "findings from Autopilot's review at minor or above",
    );
  });

  it("falls back to the description for an automation it doesn't know", () => {
    expect(say("something_new")).toBe("fallback");
  });

  it("describes a custom automation from its trigger and action", () => {
    const custom = (action: CustomDefinition["action"]): CustomDefinition => ({
      name: "x",
      trigger: { kind: "stale", status: "in_progress", hours: 48 },
      filters: { projectIds: [], labels: [], epicId: null },
      action,
    });
    const agent = {
      kind: "agent" as const,
      prompt: "Read its plan and notes.\nThen add a note.",
      skill: "",
      model: "inherit" as const,
      onPrBranch: false,
      allowedTools: [],
      inputs: [],
      slots: [],
      check: null,
      untrustedItems: true,
    };
    const sentence = (def: CustomDefinition) =>
      automationSentence({ key: "custom:1", description: "" }, {}, { custom: def });
    expect(sentence(custom(agent))).toBe(
      'When a task has been in In Progress for 48 hours, ask an agent: "Read its plan and notes."',
    );
    expect(sentence(custom({ ...agent, prompt: "Add a note" }))).toBe(
      'When a task has been in In Progress for 48 hours, ask an agent: "Add a note".',
    );
    expect(sentence(custom({ ...agent, check: { language: "node", body: "x", timeoutSeconds: 60 } }))).toContain(
      "run a node check script and, for each item it prints, ask an agent",
    );
    expect(sentence(custom({ kind: "shell", command: "make clean\nmake", timeoutSeconds: 60, inputs: [] }))).toBe(
      "When a task has been in In Progress for 48 hours, run `make clean`.",
    );
  });
});

describe("the status strip's lines", () => {
  it("sums up the limits", () => {
    expect(limitsSummary(DEFAULT_AUTOPILOT_ENGINE)).toBe("1 at a time · no caps · no quiet hours");
    expect(
      limitsSummary({
        ...DEFAULT_AUTOPILOT_ENGINE,
        maxConcurrent: 2,
        dailyRunCap: 10,
        dailySpendCapUsd: 5,
        quietHours: { enabled: true, start: "22:00", end: "07:00" },
        dryRun: true,
      }),
    ).toBe("2 at a time · 10 runs a day, $5.00 a day · quiet 22:00–07:00 · dry run");
  });

  it("counts today's runs and spend", () => {
    expect(todaySummary({ agentRuns: 1, spendUsd: 0.5 })).toBe("1 agent run today · $0.50");
  });
});

describe("field tiers", () => {
  it("reads an unset tier as advanced and splits fields in order", () => {
    const fields = [
      { key: "a", tier: "essential" as const },
      { key: "b" },
      { key: "c", tier: "advanced" as const },
      { key: "d", tier: "essential" as const },
    ];
    expect(fieldTier(fields[1]!)).toBe("advanced");
    const { essential, advanced } = splitFieldsByTier(fields);
    expect(essential.map((f) => f.key)).toEqual(["a", "d"]);
    expect(advanced.map((f) => f.key)).toEqual(["b", "c"]);
  });
});
