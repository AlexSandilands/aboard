import { AUTOMATION_BUNDLE_FORMAT, type AutomationBundle, type TaskSummary } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  firstProblem,
  formFromBundle,
  formRunsScript,
  formSentence,
  hasMoreOptions,
  rightNow,
  stepProblem,
  suggestedName,
} from "./builder.logic";
import { emptyCustomForm, type CustomForm } from "./customAutomations.logic";

const form = (overrides: Partial<CustomForm> = {}): CustomForm => ({ ...emptyCustomForm(), ...overrides });

const NOW = new Date("2026-11-07T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const task = (id: string, overrides: Partial<TaskSummary> = {}) =>
  ({
    id,
    number: Number(id.slice(1)),
    title: `Task ${id}`,
    kind: "task",
    projectId: "p1",
    status: "in_progress",
    archivedAt: null,
    labels: [],
    parent: null,
    statusChangedAt: hoursAgo(1),
    updatedAt: hoursAgo(1),
    ...overrides,
  }) as TaskSummary;
const projects = [
  { id: "p1", title: "storefront" },
  { id: "p2", title: "payments" },
];

describe("stepProblem", () => {
  it("checks only what each step shows, so a nameless, promptless form can leave When and Do", () => {
    const blank = form();
    expect(stepProblem(blank, 0)).toBeNull();
    expect(stepProblem(blank, 1)).toBeNull();
    expect(stepProblem(blank, 2)).toBe("Write the prompt the agent starts with");
  });

  it("stops When on a trigger that can't be saved", () => {
    expect(stepProblem(form({ triggerKind: "stale", staleHours: "soon" }), 0)).toBe(
      "Enter how many hours, a whole number",
    );
    expect(
      stepProblem(form({ triggerKind: "schedule", scheduleKind: "interval", unit: "minutes", every: "1" }), 0),
    ).toMatch(/^Run every \d+ to \d+ minutes$/);
  });

  it("doesn't hold Details for the name or the filters, which come later", () => {
    const details = form({ prompt: "Fix it.", labels: "x".repeat(40), name: "" });
    expect(stepProblem(details, 2)).toBeNull();
    expect(stepProblem(details, 3)).not.toBeNull();
  });

  it("asks for the name only on Review", () => {
    const ready = form({ prompt: "Fix it." });
    expect(stepProblem(ready, 3)).toBeNull();
    expect(stepProblem(ready, 4)).toBe("Give it a name");
    expect(stepProblem({ ...ready, name: "Fixer" }, 4)).toBeNull();
  });

  it("sends Save to the first step with something to fix", () => {
    expect(firstProblem(form({ triggerKind: "stale", staleHours: "x" }))).toMatchObject({ step: 0 });
    expect(firstProblem(form({ name: "Fixer" }))).toMatchObject({ step: 2 });
    expect(firstProblem(form({ name: "Fixer", prompt: "Fix it." }))).toBeNull();
  });
});

describe("suggestedName", () => {
  it("names it from the trigger and the action", () => {
    expect(suggestedName(form({ triggerKind: "pr_event", prEvent: "checks_failing" }))).toBe("PR checks fail → agent");
    expect(suggestedName(form({ triggerKind: "stale", staleStatus: "review" }))).toBe("Stuck in Review → agent");
    expect(suggestedName(form({ triggerKind: "schedule", checkOn: true }))).toBe("Daily at 09:00 → check, then agent");
    expect(suggestedName(form({ actionKind: "script", language: "python" }))).toBe("Into Review → Python script");
  });
});

describe("formSentence", () => {
  it("says when, what and where, as far as it is filled in", () => {
    expect(formSentence(form(), projects)).toBe(
      "When a task moves into Review, ask an agent. It runs in every project it's switched on in.",
    );
    expect(
      formSentence(form({ prompt: "Review the PR.\nThen comment.", projectIds: ["p2"], labels: "ui, api" }), projects),
    ).toBe(
      "When a task moves into Review, ask an agent: “Review the PR.” It runs in payments, on tasks labelled ui or api.",
    );
  });

  it("names a check script, and drops task filters for a schedule", () => {
    expect(formSentence(form({ triggerKind: "schedule", checkOn: true, labels: "ui" }), projects)).toBe(
      "Mon, Tue, Wed, Thu, Fri at 09:00, run a Node.js check script and, for each item it prints, ask an agent. It runs in every project it's switched on in.",
    );
  });
});

describe("rightNow", () => {
  const tasks = [
    task("t1", { statusChangedAt: hoursAgo(60) }),
    task("t2", { statusChangedAt: hoursAgo(10) }),
    task("t3", { statusChangedAt: hoursAgo(90), projectId: "p2" }),
    task("t4", { statusChangedAt: hoursAgo(90), status: "review" }),
  ];

  it("lists the tasks already past a 'sits too long' limit, oldest first", () => {
    const due = rightNow(form({ triggerKind: "stale", staleHours: "48" }), tasks, projects, NOW);
    expect(due).toMatchObject({ kind: "tasks", more: 0 });
    expect(due.kind === "tasks" && due.tasks.map((t) => t.id)).toEqual(["t3", "t1"]);
  });

  it("keeps to the projects picked", () => {
    const due = rightNow(form({ triggerKind: "stale", staleHours: "48", projectIds: ["p1"] }), tasks, projects, NOW);
    expect(due.kind === "tasks" && due.tasks.map((t) => t.id)).toEqual(["t1"]);
  });

  it("has nothing yet for an event, and one run per project for a schedule", () => {
    expect(rightNow(form(), tasks, projects, NOW)).toEqual({ kind: "events" });
    expect(rightNow(form({ triggerKind: "schedule" }), tasks, projects, NOW)).toEqual({
      kind: "schedule",
      projects: ["storefront", "payments"],
    });
  });
});

describe("hasMoreOptions", () => {
  it("opens More options only when something in it is set", () => {
    expect(hasMoreOptions(form())).toBe(false);
    expect(hasMoreOptions(form({ skill: "fix-ci" }))).toBe(true);
    expect(hasMoreOptions(form({ triggerKind: "schedule", checkOn: true }))).toBe(true);
    // A PR branch means nothing on a schedule, so it doesn't open it.
    expect(hasMoreOptions(form({ triggerKind: "schedule", onPrBranch: true }))).toBe(false);
  });
});

describe("formRunsScript", () => {
  it("is true for a script action and a schedule's check, which an Edit first must confirm", () => {
    expect(formRunsScript(form({ actionKind: "script" }))).toBe(true);
    expect(formRunsScript(form({ triggerKind: "schedule", checkOn: true }))).toBe(true);
    // A check is only a schedule's; switched to another trigger it isn't saved.
    expect(formRunsScript(form({ checkOn: true }))).toBe(false);
    expect(formRunsScript(form())).toBe(false);
  });
});

describe("formFromBundle", () => {
  it("fills the builder from a shared file with what the reader filled in", () => {
    const bundle: AutomationBundle = {
      format: AUTOMATION_BUNDLE_FORMAT,
      version: 1,
      name: "Fix checks",
      description: "",
      trigger: { kind: "pr_event", event: "checks_failing" },
      filters: { labels: ["ci"] },
      action: {
        kind: "agent",
        prompt: "Fix it, {{inputs.who}}.",
        skill: "",
        model: "inherit",
        onPrBranch: true,
        allowedTools: [],
        inputs: [],
        slots: [],
        check: null,
        untrustedItems: true,
      },
      inputs: [{ name: "who", label: "Who", type: "text", default: "you" }],
      slots: [],
    };
    const built = formFromBundle(bundle, { inputs: { who: "me" }, projectIds: ["p1"] });
    expect(built).toMatchObject({
      name: "Fix checks",
      triggerKind: "pr_event",
      prEvent: "checks_failing",
      labels: "ci",
      projectIds: ["p1"],
      prompt: "Fix it, {{inputs.who}}.",
      onPrBranch: true,
      inputs: [{ name: "who", value: "me" }],
    });
  });
});
