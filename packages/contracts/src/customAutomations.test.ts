import { describe, expect, it } from "vitest";
import { brandEnv } from "./brand.ts";
import {
  checkCustomDefinition,
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
  const agent = { kind: "agent" as const, prompt: "Go", skill: "", tier: null, onPrBranch: false };
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
