import { describe, expect, it } from "vitest";
import { brandEnv } from "./brand.ts";
import { nextPrChanges, type PrSnapshot } from "./schemas.ts";
import {
  checkCustomDefinition,
  customAgentPrompt,
  customAgentToolsNote,
  customAllowedTools,
  CustomAction,
  customBlockedReason,
  CUSTOM_TOOLS_MAX,
  customShellEnv,
  CustomTrigger,
  customValues,
  describeCustomTrigger,
  describeShellRun,
  latestHourlySlot,
  latestMinutesSlot,
  placeholdersIn,
  renderCustomPrompt,
  type CustomValues,
} from "./customAutomations.ts";

const values: CustomValues = {
  automation: "Ping",
  task: { id: "t1", number: 42, title: "Fix it", status: "review" },
  pr: { url: "https://github.com/o/r/pull/1" },
  project: { name: "Alpha", path: "/work/alpha" },
};

describe("custom automation templates", () => {
  it("fills known placeholders, with spaces inside the braces, and leaves unknown ones", () => {
    expect(renderCustomPrompt("#{{task.number}} {{ task.title }} {{pr.url}} {{nope}}", values)).toBe(
      "#42 Fix it https://github.com/o/r/pull/1 {{nope}}",
    );
    expect(renderCustomPrompt("{{pr.url}}|{{project.path}}", { automation: "x" })).toBe("|");
  });

  it("lists the placeholders a text names", () => {
    expect(placeholdersIn("{{task.title}} {{task.title}} {{pr.url}}")).toEqual(["task.title", "pr.url"]);
  });

  it("gives a shell command every value as a branded environment variable", () => {
    expect(customShellEnv(values)).toMatchObject({
      [brandEnv("TASK_NUMBER")]: "42",
      [brandEnv("TASK_TITLE")]: "Fix it",
      [brandEnv("PR_URL")]: "https://github.com/o/r/pull/1",
      [brandEnv("PROJECT_PATH")]: "/work/alpha",
      [brandEnv("AUTOMATION")]: "Ping",
    });
    expect(describeShellRun("make", values)).toContain(`${brandEnv("TASK_TITLE")}="Fix it"`);
  });
});

describe("checkCustomDefinition", () => {
  const filters = { projectIds: [], labels: [], epicId: null };
  const shell = { kind: "shell" as const, command: "make", timeoutSeconds: 60 };
  const agent = CustomAction.parse({ kind: "agent", prompt: "Go" }) as Extract<CustomAction, { kind: "agent" }>;
  const schedule = CustomTrigger.parse({ kind: "schedule", schedule: { kind: "hourly", everyHours: 4 } });

  it("allows a schedule with a shell command or an agent, and project filters only", () => {
    expect(checkCustomDefinition({ trigger: schedule, filters, action: shell })).toBeNull();
    expect(checkCustomDefinition({ trigger: schedule, filters, action: agent })).toBeNull();
    expect(checkCustomDefinition({ trigger: schedule, filters: { ...filters, epicId: "e" }, action: shell })).toMatch(
      /only filter by project/,
    );
    expect(checkCustomDefinition({ trigger: schedule, filters: { ...filters, labels: ["x"] }, action: agent })).toMatch(
      /only filter by project/,
    );
    expect(checkCustomDefinition({ trigger: schedule, filters, action: { ...agent, onPrBranch: true } })).toMatch(
      /no pull request/,
    );
  });

  it("holds a minutes schedule to 5 minutes through a day", () => {
    const minutes = (everyMinutes: number) =>
      CustomTrigger.safeParse({ kind: "schedule", schedule: { kind: "minutes", everyMinutes } }).success;
    expect(minutes(5)).toBe(true);
    expect(minutes(1440)).toBe(true);
    expect(minutes(4)).toBe(false);
    expect(minutes(1441)).toBe(false);
    expect(minutes(7.5)).toBe(false);
  });

  it("refuses placeholders in a shell command and unknown ones in a prompt", () => {
    const trigger = CustomTrigger.parse({ kind: "blocker_finished" });
    expect(checkCustomDefinition({ trigger, filters, action: { ...shell, command: "echo {{task.title}}" } })).toMatch(
      brandEnv("TASK_TITLE"),
    );
    expect(checkCustomDefinition({ trigger, filters, action: { ...agent, prompt: "{{task.body}}" } })).toMatch(
      /isn't a placeholder/,
    );
  });

  it("refuses a status change from and to the same column", () => {
    const trigger = CustomTrigger.parse({ kind: "status_change", from: "review", to: "review" });
    expect(checkCustomDefinition({ trigger, filters, action: shell })).toMatch(/different column/);
  });
});

describe("inputs and tool slots", () => {
  const agent = (extra: Record<string, unknown> = {}) => CustomAction.parse({ kind: "agent", prompt: "Go", ...extra });
  const filters = { projectIds: [], labels: [], epicId: null };
  const trigger = CustomTrigger.parse({ kind: "schedule", schedule: { kind: "hourly", everyHours: 1 } });
  const check = (action: CustomAction) => checkCustomDefinition({ trigger, filters, action });
  const jira = { name: "jira", label: "Jira tools", description: "search issues by JQL" };

  it("default to none, so an action saved before they existed still parses", () => {
    expect(agent()).toMatchObject({ inputs: [], slots: [] });
  });

  it("fills {{inputs.name}} from the declared values, and leaves undeclared ones", () => {
    const action = agent({
      prompt: "Run {{inputs.jql}} for {{ inputs.look_back }} days {{inputs.nope}}",
      inputs: [
        { name: "jql", label: "JQL", value: "type = Bug" },
        { name: "look_back", label: "Days", type: "number", default: "14" },
      ],
    });
    if (action.kind !== "agent") throw new Error("agent");
    expect(action.inputs[1]).toMatchObject({ value: "14", default: "14" });
    expect(customValues({ name: "x", action }, null, null).inputs).toEqual({ jql: "type = Bug", look_back: "14" });
    expect(renderCustomPrompt(action.prompt, customValues({ name: "x", action }, null, null))).toBe(
      "Run type = Bug for 14 days {{inputs.nope}}",
    );
    // A value that looks like a placeholder is data, not filled in again.
    expect(renderCustomPrompt("{{inputs.a}}", { automation: "x", inputs: { a: "{{task.title}}" } })).toBe(
      "{{task.title}}",
    );
  });

  it("refuses a prompt that names an input nobody declared, repeats and values that don't fit", () => {
    expect(check(agent({ prompt: "{{inputs.jql}}" }))).toMatch(/no input is called jql/);
    const inputs = [{ name: "a", label: "A", value: "1" }];
    expect(check(agent({ prompt: "{{inputs.a}}", inputs }))).toBeNull();
    expect(check(agent({ inputs: [...inputs, ...inputs] }))).toMatch(/declared twice/);
    expect(check(agent({ slots: [jira, jira] }))).toMatch(/declared twice/);
    expect(check(agent({ inputs: [{ name: "n", label: "N", type: "number", value: "soon" }] }))).toMatch(
      /enter a number/,
    );
    expect(check(agent({ inputs: [{ name: "b", label: "B", type: "boolean", value: "maybe" }] }))).toMatch(/yes or no/);
    expect(check(agent({ inputs: [{ name: "b", label: "B", type: "boolean", value: "false" }] }))).toBeNull();
    expect(
      CustomAction.safeParse({ kind: "agent", prompt: "Go", inputs: [{ name: "Bad Name", label: "x" }] }).success,
    ).toBe(false);
  });

  it("gives a run the tools filling its slots, and tells the prompt about the filled ones", () => {
    const action = agent({
      allowedTools: ["WebFetch"],
      slots: [{ ...jira, tools: ["mcp__issue-tracker__search_jira", "WebFetch"] }],
    });
    expect(customAllowedTools(action)).toEqual(["WebFetch", "mcp__issue-tracker__search_jira"]);
    expect(customAgentToolsNote(action)).toContain("mcp__issue-tracker__search_jira");
    const prompt = customAgentPrompt({ name: "x", action }, { automation: "x" }, null, null);
    expect(prompt).toContain("- Jira tools (search issues by JQL): mcp__issue-tracker__search_jira, WebFetch");
    const empty = agent({ slots: [jira] });
    expect(customAgentPrompt({ name: "x", action: empty }, { automation: "x" }, null, null)).not.toContain(
      "Jira tools",
    );
    expect(customAllowedTools(CustomAction.parse({ kind: "shell", command: "make" }))).toEqual([]);
  });

  it("says what is missing while a slot is empty", () => {
    expect(customBlockedReason(agent())).toBeNull();
    expect(
      customBlockedReason(agent({ slots: [jira, { ...jira, name: "b", label: "Chat", tools: ["mcp__chat"] }] })),
    ).toBe("Won't work until you fill in: Jira tools");
    expect(customBlockedReason(agent({ slots: [{ ...jira, tools: ["mcp__j"] }] }))).toBeNull();
    expect(CustomAction.safeParse({ kind: "agent", prompt: "Go", slots: [{ ...jira, tools: ["Bash"] }] }).success).toBe(
      false,
    );
  });
});

describe("an agent action's allowed tools", () => {
  const parse = (allowedTools?: string[]) =>
    CustomAction.safeParse({ kind: "agent", prompt: "Go", ...(allowedTools ? { allowedTools } : {}) });

  it("defaults to none, so an action saved before the field existed still parses", () => {
    expect(parse()).toMatchObject({ success: true, data: { allowedTools: [] } });
  });

  it("takes MCP servers, MCP tools and built-in tools, trimmed and without repeats", () => {
    const tools = [
      "mcp__issue-tracker",
      " mcp__issue-tracker__search_jira ",
      "mcp__issue-tracker__search_*",
      "WebFetch",
      "WebFetch(domain:example.com)",
    ];
    expect(parse([...tools, "mcp__issue-tracker"])).toMatchObject({
      success: true,
      data: { allowedTools: tools.map((t) => t.trim()) },
    });
  });

  it("refuses anything else", () => {
    for (const bad of [
      "",
      "issue-tracker",
      "mcp__",
      "mcp__*",
      "mcp__issue*__search_jira",
      "mcp__a b",
      "webfetch",
      "WebFetch(",
      // Shell tools would sidestep the Bash push and merge deny rules.
      "Bash",
      "Bash(gh pr view *)",
      "PowerShell",
    ]) {
      expect(parse([bad]).success).toBe(false);
    }
  });

  it("caps how long a rule is", () => {
    expect(parse([`mcp__${"a".repeat(195)}`]).success).toBe(true);
    expect(parse([`mcp__${"a".repeat(196)}`]).success).toBe(false);
  });

  it("caps how many there are", () => {
    expect(parse(Array.from({ length: CUSTOM_TOOLS_MAX + 1 }, (_, i) => `mcp__s${i}`)).success).toBe(false);
  });
});

describe("triggers", () => {
  it("describes each kind in a line", () => {
    expect(describeCustomTrigger(CustomTrigger.parse({ kind: "status_change", from: "done", to: "in_progress" }))).toBe(
      "When a task moves from Done into In Progress",
    );
    expect(describeCustomTrigger(CustomTrigger.parse({ kind: "pr_event", event: "checks_failing" }))).toBe(
      "When a pull request's checks fail",
    );
    expect(
      describeCustomTrigger(
        CustomTrigger.parse({ kind: "schedule", schedule: { kind: "weekly", days: [1, 3], time: "09:00" } }),
      ),
    ).toBe("Mon, Wed at 09:00");
    expect(describeCustomTrigger(CustomTrigger.parse({ kind: "stale", hours: 1 }))).toBe(
      "When a task has been in In Progress for 1 hour",
    );
  });

  it("counts hourly slots from local midnight", () => {
    expect(latestHourlySlot(6, new Date(2026, 9, 17, 13, 45))).toEqual(new Date(2026, 9, 17, 12));
    expect(latestHourlySlot(24, new Date(2026, 9, 17, 23, 59))).toEqual(new Date(2026, 9, 17, 0));
  });

  it("counts minute slots from local midnight, restarting each day", () => {
    expect(latestMinutesSlot(15, new Date(2026, 9, 17, 13, 44, 59))).toEqual(new Date(2026, 9, 17, 13, 30));
    expect(latestMinutesSlot(15, new Date(2026, 9, 17, 13, 45))).toEqual(new Date(2026, 9, 17, 13, 45));
    expect(latestMinutesSlot(7, new Date(2026, 9, 17, 0, 20))).toEqual(new Date(2026, 9, 17, 0, 14));
    expect(latestMinutesSlot(90, new Date(2026, 9, 17, 4, 0))).toEqual(new Date(2026, 9, 17, 3, 0));
    expect(latestMinutesSlot(1440, new Date(2026, 9, 17, 23, 59))).toEqual(new Date(2026, 9, 17, 0, 0));
  });

  it("describes a minutes schedule", () => {
    expect(
      describeCustomTrigger(CustomTrigger.parse({ kind: "schedule", schedule: { kind: "minutes", everyMinutes: 15 } })),
    ).toBe("Every 15 minutes");
  });
});

describe("nextPrChanges", () => {
  const snap = (patch: Partial<PrSnapshot> = {}): PrSnapshot => ({
    state: "open",
    title: "x",
    checks: "passing",
    reviewDecision: null,
    mergeable: "mergeable",
    headRef: "b",
    updatedAt: null,
    headOid: "a1",
    ...patch,
  });

  it("records the first snapshot without stamping it: a state the board finds in place isn't new", () => {
    expect(
      nextPrChanges(null, snap({ checks: "failing", state: "merged", mergeable: "conflicting" }), {}, "t1"),
    ).toEqual({
      failing: true,
      conflicting: true,
    });
  });

  it("stamps facts when they begin, keeps them while they hold, and the head only when it moves", () => {
    const first = nextPrChanges(null, snap(), {}, "t0");
    const failed = nextPrChanges(snap(), snap({ checks: "failing" }), first, "t1");
    expect(failed).toMatchObject({ checksFailing: "t1", failing: true });
    const still = nextPrChanges(snap({ checks: "failing" }), snap({ checks: "failing", headOid: "b2" }), failed, "t2");
    expect(still).toMatchObject({ checksFailing: "t1", newHead: "t2" });
    const merged = nextPrChanges(snap(), snap({ state: "merged", mergeable: "conflicting" }), first, "t3");
    expect(merged).toMatchObject({ merged: "t3", conflict: "t3" });
    expect(nextPrChanges(snap(), null, merged, "t4")).toBe(merged);
  });

  it("keeps the last known state through pending checks and unknown mergeability", () => {
    let changes = nextPrChanges(null, snap({ checks: "failing", mergeable: "conflicting" }), {}, "t0");
    // A push re-runs the checks, which fail again; GitHub recomputes mergeability, still conflicting.
    changes = nextPrChanges(
      snap({ checks: "failing" }),
      snap({ checks: "pending", mergeable: "unknown" }),
      changes,
      "t1",
    );
    changes = nextPrChanges(
      snap({ checks: "pending" }),
      snap({ checks: "failing", mergeable: "conflicting" }),
      changes,
      "t2",
    );
    expect(changes.checksFailing).toBeUndefined();
    expect(changes.conflict).toBeUndefined();
    // Passing, then failing again, is a new failure.
    changes = nextPrChanges(snap({ checks: "failing" }), snap({ checks: "passing" }), changes, "t3");
    changes = nextPrChanges(snap({ checks: "passing" }), snap({ checks: "failing" }), changes, "t4");
    expect(changes.checksFailing).toBe("t4");
  });
});
