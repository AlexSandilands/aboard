import { brandEnv, CUSTOM_SCRIPT_MAX, type CustomAutomation, type Project, type TaskSummary } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  customFormToInput,
  emptyCustomForm,
  emptyFormSlots,
  formFromCustom,
  formSampleTask,
  previewAction,
  sampleTask,
  testScriptRequest,
  withActionKind,
  withCheck,
  withLanguage,
} from "./customAutomations.logic";
import { scriptStarter } from "./scripts.logic";

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
          inputs: [],
          slots: [],
          check: null,
          untrustedItems: true,
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
    const interval = {
      ...emptyCustomForm(),
      name: "A",
      triggerKind: "schedule" as const,
      scheduleKind: "interval" as const,
    };
    expect(customFormToInput({ ...interval, prompt: "Go", unit: "minutes", every: "4" })).toMatchObject({
      ok: false,
      error: "Run every 5 to 1440 minutes",
    });
    expect(customFormToInput({ ...interval, prompt: "Go", unit: "minutes", every: "1441" })).toMatchObject({
      ok: false,
    });
    expect(customFormToInput({ ...interval, prompt: "Go", unit: "hours", every: "25" })).toMatchObject({
      ok: false,
      error: "Run every 1 to 24 hours",
    });
    expect(customFormToInput({ ...interval, prompt: "Go", unit: "minutes", every: "15", labels: "ui" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/only filter by project/),
    });
  });

  it("takes an agent on a schedule, in minutes or hours", () => {
    const interval = {
      ...emptyCustomForm(),
      name: "A",
      triggerKind: "schedule" as const,
      scheduleKind: "interval" as const,
      prompt: "Go",
    };
    expect(customFormToInput({ ...interval, unit: "minutes", every: "15" })).toMatchObject({
      ok: true,
      input: {
        trigger: { kind: "schedule", schedule: { kind: "minutes", everyMinutes: 15 } },
        action: { kind: "agent", prompt: "Go" },
      },
    });
    expect(customFormToInput({ ...interval, unit: "hours", every: "2" })).toMatchObject({
      ok: true,
      input: { trigger: { kind: "schedule", schedule: { kind: "hourly", everyHours: 2 } } },
    });
  });

  it("drops the pull request branch switch when the trigger becomes a schedule, which has no pull request", () => {
    const form = {
      ...emptyCustomForm(),
      name: "A",
      prompt: "Go",
      onPrBranch: true,
      triggerKind: "schedule" as const,
      scheduleKind: "interval" as const,
      unit: "minutes" as const,
      every: "15",
    };
    expect(customFormToInput(form)).toMatchObject({ ok: true, input: { action: { onPrBranch: false } } });
  });

  it("round-trips a scheduled agent every few minutes", () => {
    const saved = custom({
      trigger: { kind: "schedule", schedule: { kind: "minutes", everyMinutes: 15 } },
      action: {
        kind: "agent",
        prompt: "Go",
        skill: "orchestrate",
        tier: null,
        onPrBranch: false,
        allowedTools: [],
        inputs: [],
        slots: [],
        check: null,
        untrustedItems: true,
      },
    });
    expect(customFormToInput(formFromCustom(saved))).toEqual({
      ok: true,
      input: { name: saved.name, trigger: saved.trigger, filters: saved.filters, action: saved.action },
    });
  });

  it("round-trips an agent's check script through the editor's fields", () => {
    const saved = custom({
      trigger: { kind: "schedule", schedule: { kind: "minutes", everyMinutes: 15 } },
      action: {
        kind: "agent",
        prompt: "Look at {{item.title}}",
        skill: "",
        tier: null,
        onPrBranch: false,
        allowedTools: [],
        inputs: [],
        slots: [],
        check: { language: "python", body: "print('{}')", timeoutSeconds: 60 },
        untrustedItems: false,
      },
    });
    expect(customFormToInput({ ...formFromCustom(saved), name: "Renamed" })).toMatchObject({
      ok: true,
      input: { name: "Renamed", action: saved.action },
    });
  });

  it("reads the allowed tools one per line, and gives them back one per line", () => {
    const result = customFormToInput({
      ...emptyCustomForm(),
      name: "Dispatch",
      prompt: "Go",
      allowedTools: [" mcp__issue-tracker ", "", "mcp__issue-tracker__search_jira", "WebFetch(domain:a.com,b.com)", ""].join(
        NL,
      ),
    });
    expect(result).toMatchObject({
      ok: true,
      input: {
        action: { allowedTools: ["mcp__issue-tracker", "mcp__issue-tracker__search_jira", "WebFetch(domain:a.com,b.com)"] },
      },
    });
    const saved = custom({
      action: {
        kind: "agent",
        prompt: "Go",
        skill: "",
        tier: null,
        onPrBranch: false,
        allowedTools: ["mcp__a", "mcp__b__c"],
        inputs: [],
        slots: [],
        check: null,
        untrustedItems: true,
      },
    });
    expect(formFromCustom(saved).allowedTools).toBe(["mcp__a", "mcp__b__c"].join(NL));
    expect(customFormToInput(formFromCustom(saved))).toMatchObject({ ok: true, input: { action: saved.action } });
  });

  it("round-trips inputs and slots, with a slot's tools one per line, and numbers the one that is wrong", () => {
    const saved = custom({
      action: {
        kind: "agent",
        prompt: "Run {{inputs.jql}}",
        skill: "",
        tier: null,
        onPrBranch: false,
        allowedTools: [],
        inputs: [{ name: "jql", label: "JQL", type: "text", default: "type = Bug", value: "project = X" }],
        slots: [{ name: "jira", label: "Jira tools", description: "search", tools: ["mcp__a__b", "mcp__a__c"] }],
        check: null,
        untrustedItems: true,
      },
    });
    const form = formFromCustom(saved);
    expect(form.slots[0]!.tools).toBe(["mcp__a__b", "mcp__a__c"].join(NL));
    expect(form.inputs[0]).toMatchObject({ value: "project = X", default: "type = Bug" });
    expect(customFormToInput(form)).toMatchObject({ ok: true, input: { action: saved.action } });
    expect(customFormToInput({ ...form, slots: [{ ...form.slots[0]!, tools: "Bash" }] })).toEqual({
      ok: false,
      error: expect.stringMatching(/^Tool slot 1:/),
    });
    expect(customFormToInput({ ...form, inputs: [{ ...form.inputs[0]!, name: "Bad Name" }] })).toEqual({
      ok: false,
      error: expect.stringMatching(/^Input 1:/),
    });
    expect(customFormToInput({ ...form, prompt: "{{inputs.nope}}" })).toEqual({
      ok: false,
      error: expect.stringContaining("no input is called nope"),
    });
    expect(emptyFormSlots({ slots: [{ ...form.slots[0]!, tools: " " }, form.slots[0]!] })).toHaveLength(1);
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

describe("a script automation in the form", () => {
  const action = {
    kind: "script" as const,
    language: "python" as const,
    body: "if x:\r\n    print(1)\r\n",
    timeoutSeconds: 45,
  };

  it("is saved back as it was, indentation and line endings kept", () => {
    const saved = custom({ action });
    const form = formFromCustom(saved);
    expect(form.actionKind).toBe("script");
    expect(customFormToInput(form)).toMatchObject({ ok: true, input: { action } });
  });

  it("previews the script with the sample task's variables", () => {
    const preview = previewAction(
      { name: "Ping", trigger: { kind: "status_change", to: "review" }, action },
      task("t"),
      [project],
    );
    expect(preview).toContain("print(1)");
    expect(preview).toContain(`${brandEnv("TASK_NUMBER")}="7"`);
  });
});

describe("the check script in the form", () => {
  const scheduled = (over: Partial<ReturnType<typeof emptyCustomForm>> = {}) => ({
    ...emptyCustomForm(),
    name: "Triage",
    prompt: "Look at {{item.title}}",
    triggerKind: "schedule" as const,
    checkOn: true,
    checkLanguage: "python" as const,
    checkBody: "print('{}')",
    checkTimeoutSeconds: "60",
    ...over,
  });

  it("is read from what was typed, with its own timeout", () => {
    expect(customFormToInput(scheduled())).toMatchObject({
      ok: true,
      input: { action: { check: { language: "python", body: "print('{}')", timeoutSeconds: 60 } } },
    });
  });

  it("is left out when it is switched off, and when the trigger can't have one", () => {
    expect(customFormToInput(scheduled({ checkOn: false, prompt: "Go" }))).toMatchObject({
      input: { action: { check: null } },
    });
    expect(customFormToInput(scheduled({ triggerKind: "status_change", prompt: "Go" }))).toMatchObject({
      ok: true,
      input: { action: { check: null } },
    });
  });

  it("says what is wrong with an empty script or timeout", () => {
    expect(customFormToInput(scheduled({ checkBody: "  " }))).toEqual({
      ok: false,
      error: "Write the check script, or switch the check off",
    });
    expect(customFormToInput(scheduled({ checkTimeoutSeconds: "soon" }))).toMatchObject({ ok: false });
    expect(customFormToInput(scheduled({ checkTimeoutSeconds: "9999" }))).toEqual({
      ok: false,
      error: "The check's timeout is 1 to 3600 seconds",
    });
  });

  it("refuses untrusted items with allowed tools, as the server does", () => {
    expect(customFormToInput(scheduled({ allowedTools: "WebFetch" }))).toMatchObject({ ok: false });
    expect(customFormToInput(scheduled({ allowedTools: "WebFetch", untrustedItems: false }))).toMatchObject({
      ok: true,
    });
  });

  it("starts from the starter when switched on with nothing written, and keeps what was written", () => {
    const form = { ...emptyCustomForm(), checkLanguage: "powershell" as const };
    expect(withCheck(form, true)).toMatchObject({ checkOn: true, checkBody: scriptStarter("powershell", "check") });
    expect(withCheck({ ...form, checkBody: "mine" }, true).checkBody).toBe("mine");
    expect(withCheck({ ...form, checkBody: "mine" }, false)).toMatchObject({ checkOn: false, checkBody: "mine" });
  });
});

describe("a script action's editor", () => {
  it("starts a new script from its language's starter", () => {
    const form = withActionKind(emptyCustomForm(), "script");
    expect(form.actionKind).toBe("script");
    expect(form.body).toBe(scriptStarter("node", "action"));
    expect(customFormToInput({ ...form, name: "Ping" })).toMatchObject({
      ok: true,
      input: { action: { kind: "script", language: "node", timeoutSeconds: 300 } },
    });
  });

  it("swaps the starter for the new language's, but never what the user wrote", () => {
    const starter = withActionKind(emptyCustomForm(), "script");
    expect(withLanguage(starter, "action", "python")).toMatchObject({
      language: "python",
      body: scriptStarter("python", "action"),
    });
    const written = { ...starter, body: "console.log('mine')" };
    expect(withLanguage(written, "action", "python")).toMatchObject({ language: "python", body: written.body });
    const check = { ...starter, checkBody: scriptStarter("node", "check") };
    expect(withLanguage(check, "check", "sh").checkBody).toBe(scriptStarter("sh", "check"));
  });

  it("asks for a script before saving", () => {
    expect(customFormToInput({ ...emptyCustomForm(), name: "Ping", actionKind: "script", body: " " })).toEqual({
      ok: false,
      error: "Write the script to run",
    });
  });
});

describe("a test run's request", () => {
  const form = {
    ...emptyCustomForm(),
    name: "Triage",
    prompt: "Look at {{item.title}}",
    skill: "triage",
    inputs: [{ name: "depth", label: "Depth", type: "number" as const, value: "3", default: "1" }],
    actionKind: "script" as const,
    language: "sh" as const,
    body: "echo hi",
    timeoutSeconds: "20",
    checkLanguage: "python" as const,
    checkBody: "print('{}')",
    checkTimeoutSeconds: "40",
  };

  it("carries an action's script and the task it is given", () => {
    expect(testScriptRequest(form, "action", "p", "t1")).toEqual({
      ok: true,
      input: {
        projectId: "p",
        role: "action",
        taskId: "t1",
        name: "Triage",
        inputs: {},
        prompt: "",
        skill: "",
        script: { language: "sh", body: "echo hi", timeoutSeconds: 20 },
      },
    });
  });

  it("carries a check's script with the agent's prompt, and no task", () => {
    expect(testScriptRequest(form, "check", "p", "t1")).toMatchObject({
      ok: true,
      input: {
        role: "check",
        taskId: null,
        inputs: { depth: "3" },
        prompt: "Look at {{item.title}}",
        skill: "triage",
        script: { language: "python", body: "print('{}')", timeoutSeconds: 40 },
      },
    });
  });

  it("says a script is too long rather than empty", () => {
    const body = "x".repeat(CUSTOM_SCRIPT_MAX + 1);
    const long = `The script is over ${CUSTOM_SCRIPT_MAX} characters`;
    expect(testScriptRequest({ ...form, body }, "action", "p")).toEqual({ ok: false, error: long });
    expect(customFormToInput({ ...form, body })).toEqual({ ok: false, error: long });
    expect(
      customFormToInput({ ...form, actionKind: "agent", triggerKind: "schedule", checkOn: true, checkBody: body }),
    ).toEqual({ ok: false, error: long });
  });

  it("says what to fix first", () => {
    expect(testScriptRequest({ ...form, body: " " }, "action", "p")).toEqual({
      ok: false,
      error: "Write the script first",
    });
    expect(testScriptRequest({ ...form, timeoutSeconds: "x" }, "action", "p")).toMatchObject({ ok: false });
    expect(testScriptRequest({ ...form, checkTimeoutSeconds: "0" }, "check", "p")).toEqual({
      ok: false,
      error: "The timeout is 1 to 3600 seconds",
    });
  });
});

describe("the task a test run is given", () => {
  it("is the newest the form's filters let through, even before the form can be saved", () => {
    const tasks = [
      task("a", { labels: ["ui"] }),
      task("b", { labels: ["api"], updatedAt: "2026-10-09T00:00:00.000Z" }),
    ];
    const form = { ...emptyCustomForm(), actionKind: "script" as const, body: "", labels: "ui" };
    expect(formSampleTask(form, tasks)?.id).toBe("a");
    expect(formSampleTask({ ...form, labels: "" }, tasks)?.id).toBe("b");
    expect(formSampleTask({ ...form, triggerKind: "schedule" }, tasks)).toBeNull();
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
    expect(agent).not.toContain("Allowed to call");
    const withTools = previewAction(
      {
        name: "Ping",
        trigger: { kind: "status_change", to: "review" },
        action: { kind: "agent", prompt: "Go", allowedTools: ["mcp__issue-tracker__search_jira"] },
      },
      task("t"),
      [project],
    );
    expect(withTools).toContain(
      "Allowed to call without asking, on top of the usual tools: mcp__issue-tracker__search_jira",
    );
  });

  it("previews a scheduled agent with the project footer and no task", () => {
    const scheduled = previewAction(
      {
        name: "Watch",
        trigger: { kind: "schedule", schedule: { kind: "minutes", everyMinutes: 15 } },
        action: { kind: "agent", prompt: "Check on {{project.name}}" },
      },
      null,
      [project],
    );
    expect(scheduled).toContain("Check on Alpha");
    expect(scheduled).toContain("Project folder: /work/alpha");
    expect(scheduled).not.toContain("get_task");
  });
});
