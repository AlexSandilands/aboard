import { brandEnv, type CustomAutomation, type Project, type TaskSummary } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  customFormToInput,
  emptyCustomForm,
  formFromCustom,
  previewAction,
  sampleTask,
} from "./customAutomations.logic";

const task = (id: string, overrides: Partial<TaskSummary> = {}) =>
  ({
    id,
    number: 7,
    title: "Fix it",
    kind: "task",
    projectId: "p",
    status: "review",
    archivedAt: null,
    labels: [],
    parent: null,
    links: [],
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  }) as TaskSummary;

const project = { id: "p", title: "Alpha", workspaceRoot: "/work/alpha", archivedAt: null } as Project;

const custom = (over: Partial<CustomAutomation>): CustomAutomation => ({
  id: "c1",
  name: "Ping",
  trigger: { kind: "status_change", to: "review", from: null },
  filters: { projectIds: [], labels: [], epicId: null },
  action: { kind: "shell", command: "make", timeoutSeconds: 60 },
  armedAt: "2026-10-01T00:00:00.000Z",
  armedProjects: {},
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const NL = String.fromCharCode(10);

describe("custom automation form", () => {
  it("turns into the input the server takes, labels normalised", () => {
    const result = customFormToInput({
      ...emptyCustomForm(),
      name: " Fix checks ",
      triggerKind: "pr_event",
      prEvent: "checks_failing",
      labels: "UI,  backend ,",
      prompt: "Fix {{pr.url}}",
      tier: "light",
    });
    expect(result).toEqual({
      ok: true,
      input: {
        name: "Fix checks",
        trigger: { kind: "pr_event", event: "checks_failing" },
        filters: { projectIds: [], labels: ["ui", "backend"], epicId: null },
        action: {
          kind: "agent",
          prompt: "Fix {{pr.url}}",
          skill: "",
          tier: "light",
          onPrBranch: false,
          allowedTools: [],
        },
      },
    });
  });

  it("says what to fix", () => {
    expect(customFormToInput({ ...emptyCustomForm(), prompt: "Go" })).toEqual({ ok: false, error: "Give it a name" });
    expect(customFormToInput({ ...emptyCustomForm(), name: "A", triggerKind: "stale", staleHours: "x" })).toMatchObject(
      {
        ok: false,
        error: expect.stringMatching(/hours/),
      },
    );
    expect(
      customFormToInput({ ...emptyCustomForm(), name: "A", actionKind: "shell", command: "echo {{task.title}}" }),
    ).toMatchObject({ ok: false, error: expect.stringContaining(brandEnv("TASK_TITLE")) });
    expect(customFormToInput({ ...emptyCustomForm(), name: "A", triggerKind: "schedule", prompt: "Go" })).toMatchObject(
      {
        ok: false,
        error: expect.stringMatching(/no task/),
      },
    );
  });

  it("reads the allowed tools one per line or comma-separated, and gives them back one per line", () => {
    const result = customFormToInput({
      ...emptyCustomForm(),
      name: "Dispatch",
      prompt: "Go",
      allowedTools: [" mcp__issue-tracker ", "", "mcp__issue-tracker__search_jira, WebFetch", ""].join(NL),
    });
    expect(result).toMatchObject({
      ok: true,
      input: { action: { allowedTools: ["mcp__issue-tracker", "mcp__issue-tracker__search_jira", "WebFetch"] } },
    });
    const saved = custom({
      action: {
        kind: "agent",
        prompt: "Go",
        skill: "",
        tier: null,
        onPrBranch: false,
        allowedTools: ["mcp__a", "mcp__b__c"],
      },
    });
    expect(formFromCustom(saved).allowedTools).toBe(["mcp__a", "mcp__b__c"].join(NL));
    expect(customFormToInput(formFromCustom(saved))).toMatchObject({ ok: true, input: { action: saved.action } });
  });

  it("names the allowed tool that isn't one", () => {
    expect(
      customFormToInput({
        ...emptyCustomForm(),
        name: "A",
        prompt: "Go",
        allowedTools: ["mcp__ok", "issue-tracker"].join(NL),
      }),
    ).toEqual({ ok: false, error: expect.stringContaining('"issue-tracker"') });
    expect(
      customFormToInput({
        ...emptyCustomForm(),
        name: "A",
        prompt: "Go",
        allowedTools: Array.from({ length: 21 }, (_, i) => `mcp__s${i}`).join(NL),
      }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/^Allowed tools:/) });
  });

  it("round-trips a saved automation", () => {
    const saved = custom({
      trigger: { kind: "schedule", schedule: { kind: "hourly", everyHours: 6 } },
      filters: { projectIds: ["p"], labels: [], epicId: null },
    });
    const result = customFormToInput(formFromCustom(saved));
    expect(result).toEqual({
      ok: true,
      input: { name: saved.name, trigger: saved.trigger, filters: saved.filters, action: saved.action },
    });
  });
});

describe("preview", () => {
  it("picks the newest task the filters let through", () => {
    const tasks = [
      task("old", { labels: ["ui"], updatedAt: "2026-10-01T00:00:00.000Z" }),
      task("new", { labels: ["ui"], updatedAt: "2026-10-05T00:00:00.000Z" }),
      task("unlabelled", { updatedAt: "2026-10-09T00:00:00.000Z" }),
      task("epic", { kind: "epic", labels: ["ui"], updatedAt: "2026-10-09T00:00:00.000Z" }),
      task("elsewhere", { projectId: "q", labels: ["ui"], updatedAt: "2026-10-09T00:00:00.000Z" }),
    ];
    expect(sampleTask({ filters: { projectIds: ["p"], labels: ["ui"], epicId: null } }, tasks)?.id).toBe("new");
  });

  it("shows the command with the sample task's variables, and the filled prompt", () => {
    const shell = previewAction(
      {
        name: "Ping",
        trigger: { kind: "status_change", to: "review" },
        action: { kind: "shell", command: "./notify.sh" },
      },
      task("t"),
      [project],
    );
    expect(shell).toContain("./notify.sh");
    expect(shell).toContain(`${brandEnv("TASK_NUMBER")}="7"`);
    expect(shell).toContain(`${brandEnv("PROJECT_PATH")}="/work/alpha"`);
    const agent = previewAction(
      {
        name: "Ping",
        trigger: { kind: "status_change", to: "review" },
        action: { kind: "agent", prompt: "Look at #{{task.number}} {{task.title}}" },
      },
      task("t"),
      [project],
    );
    expect(agent).toContain("Look at #7 Fix it");
    expect(agent).toContain('get_task("#7")');
  });
});
