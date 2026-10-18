import { describe, expect, it } from "vitest";
import { brandEnv } from "./brand.ts";
import { nextPrChanges, type PrSnapshot } from "./schemas.ts";
import {
  checkCustomDefinition,
  CustomAction,
  CUSTOM_TOOLS_MAX,
  customShellEnv,
  CustomTrigger,
  describeCustomTrigger,
  describeShellRun,
  latestHourlySlot,
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
  const agent = { kind: "agent" as const, prompt: "Go", skill: "", tier: null, onPrBranch: false, allowedTools: [] };
  const schedule = CustomTrigger.parse({ kind: "schedule", schedule: { kind: "hourly", everyHours: 4 } });

  it("allows a schedule only with a shell command and project filters", () => {
    expect(checkCustomDefinition({ trigger: schedule, filters, action: shell })).toBeNull();
    expect(checkCustomDefinition({ trigger: schedule, filters, action: agent })).toMatch(/no task/);
    expect(checkCustomDefinition({ trigger: schedule, filters: { ...filters, epicId: "e" }, action: shell })).toMatch(
      /only filter by project/,
    );
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
      "x".repeat(300),
    ]) {
      expect(parse([bad]).success).toBe(false);
    }
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
