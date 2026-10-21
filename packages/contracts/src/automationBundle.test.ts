import { describe, expect, it } from "vitest";
import {
  actionRunsCode,
  actionScripts,
  AUTOMATION_BUNDLE_FORMAT,
  AUTOMATION_BUNDLE_VERSION,
  SCRIPT_BUNDLE_VERSION,
  automationBundle,
  bundleToDefinition,
  inputStartValue,
  parseAutomationBundle,
  PLAIN_BUNDLE_VERSION,
} from "./automationBundle.ts";
import {
  checkCustomDefinition,
  CUSTOM_SCRIPT_MAX,
  CreateCustomAutomationInput,
  CustomAction,
  CustomTrigger,
  type CustomDefinition,
} from "./customAutomations.ts";

/** An agent action with a `check` of any shape, however the action's own schema treats one. */
const withCheck = (agent: CustomAction, check: unknown): CustomAction => Object.assign({}, agent, { check });

const definition = (): CustomDefinition => ({
  name: "Triage",
  trigger: CustomTrigger.parse({ kind: "status_change", to: "review" }),
  filters: { projectIds: ["p1"], labels: ["bug"], epicId: "e1" },
  action: CustomAction.parse({
    kind: "agent",
    prompt: "Run {{inputs.jql}}",
    skill: "triage",
    allowedTools: ["WebFetch"],
    inputs: [{ name: "jql", label: "JQL", value: "type = Bug" }],
    slots: [{ name: "jira", label: "Jira tools", description: "search", tools: ["mcp__issue-tracker__search_jira"] }],
  }),
});

describe("automation bundles", () => {
  it("leaves out the sharer's projects, epic and slot tools, and keeps input values as defaults", () => {
    const bundle = automationBundle(definition(), { name: "triage", body: "---\nname: triage\n---\nDo it" });
    expect(bundle).toMatchObject({
      format: AUTOMATION_BUNDLE_FORMAT,
      version: PLAIN_BUNDLE_VERSION,
      filters: { labels: ["bug"] },
      inputs: [{ name: "jql", default: "type = Bug" }],
      slots: [{ name: "jira", label: "Jira tools", description: "search" }],
      skill: { name: "triage" },
    });
    const json = JSON.stringify(bundle);
    expect(json).not.toContain("p1");
    expect(json).not.toContain("e1");
    expect(json).not.toContain("search_jira");
    expect(bundle.action).toMatchObject({ kind: "agent", allowedTools: ["WebFetch"], inputs: [], slots: [] });
  });

  it("round-trips through JSON into a definition with the importer's values", () => {
    const parsed = parseAutomationBundle(JSON.parse(JSON.stringify(automationBundle(definition()))));
    if (!parsed.ok) throw new Error(parsed.error);
    const input = bundleToDefinition(parsed.bundle, {
      inputs: { jql: "project = X" },
      slots: { jira: ["mcp__atlassian__search"] },
      projectIds: ["p2"],
    });
    const def = CreateCustomAutomationInput.parse(input);
    expect(checkCustomDefinition(def)).toBeNull();
    expect(def.filters).toEqual({ projectIds: ["p2"], labels: ["bug"], epicId: null });
    expect(def.action).toMatchObject({
      inputs: [{ name: "jql", value: "project = X", default: "type = Bug" }],
      slots: [{ name: "jira", tools: ["mcp__atlassian__search"] }],
    });
  });

  it("comes in with empty slots and default inputs unless filled", () => {
    const parsed = parseAutomationBundle(automationBundle(definition()));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(CreateCustomAutomationInput.parse(bundleToDefinition(parsed.bundle)).action).toMatchObject({
      inputs: [{ value: "type = Bug" }],
      slots: [{ tools: [] }],
    });
  });

  it("names no skill unless one was installed", () => {
    const parsed = parseAutomationBundle(automationBundle(definition(), { name: "triage", body: "x" }));
    if (!parsed.ok) throw new Error(parsed.error);
    const skillOf = (skill?: string | null) =>
      (CreateCustomAutomationInput.parse(bundleToDefinition(parsed.bundle, { skill })).action as { skill: string })
        .skill;
    expect(skillOf()).toBe("");
    expect(skillOf(null)).toBe("");
    expect(skillOf("triage-2")).toBe("triage-2");
  });

  it("starts a yes / no input with no default at no, so it is a valid choice from the start", () => {
    const input = { name: "ok", label: "OK", type: "boolean" as const, default: "" };
    expect(inputStartValue(input)).toBe("false");
    expect(inputStartValue({ ...input, default: "true" })).toBe("true");
    expect(inputStartValue({ ...input, type: "text" })).toBe("");
  });

  it("refuses what isn't an automation file, a file from a newer version and a broken one", () => {
    expect(parseAutomationBundle({ hello: 1 })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/isn't a .* automation file/),
    });
    expect(parseAutomationBundle(null).ok).toBe(false);
    const good = automationBundle(definition());
    expect(parseAutomationBundle({ ...good, version: AUTOMATION_BUNDLE_VERSION + 1 })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/newer/),
    });
    expect(parseAutomationBundle({ ...good, trigger: { kind: "sometimes" } }).ok).toBe(false);
    expect(parseAutomationBundle({ ...good, skill: { name: "../evil", body: "x" } }).ok).toBe(false);
    expect(parseAutomationBundle({ ...good, action: { kind: "shell", command: "make" } })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Only an agent/),
    });
  });
});

describe("automation bundles that carry a script", () => {
  const script = { kind: "script", language: "python", body: "print('x')\n  # kept\n" } as const;
  const scripted = (): CustomDefinition => ({ ...definition(), action: CustomAction.parse(script) });

  it("is written as the version that holds a script, and a file without one stays at version 1", () => {
    expect(automationBundle(scripted()).version).toBe(SCRIPT_BUNDLE_VERSION);
    expect(automationBundle(definition()).version).toBe(PLAIN_BUNDLE_VERSION);
    expect(
      automationBundle({ ...definition(), action: CustomAction.parse({ kind: "shell", command: "make" }) }).version,
    ).toBe(PLAIN_BUNDLE_VERSION);
  });

  it("round-trips a script action through JSON, body and language as written", () => {
    const parsed = parseAutomationBundle(JSON.parse(JSON.stringify(automationBundle(scripted()))));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.bundle.action).toMatchObject({ kind: "script", language: "python", body: script.body });
    const def = CreateCustomAutomationInput.parse(bundleToDefinition(parsed.bundle));
    expect(checkCustomDefinition(def)).toBeNull();
    expect(def.action).toMatchObject({ kind: "script", language: "python", body: script.body, timeoutSeconds: 300 });
  });

  it("still reads files from before scripts, as version 1", () => {
    const old = JSON.parse(JSON.stringify(automationBundle(definition())));
    expect(old.version).toBe(1);
    expect(parseAutomationBundle(old).ok).toBe(true);
  });

  it("refuses a script in a version 1 file, which an older board would read without it", () => {
    const file = { ...automationBundle(scripted()), version: PLAIN_BUNDLE_VERSION };
    expect(parseAutomationBundle(file)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/needs a version 2 file/),
    });
  });

  it("refuses a script past the size limit and a blank one", () => {
    const file = automationBundle(scripted());
    const withBody = (body: string) => ({ ...file, action: { ...file.action, body } });
    expect(parseAutomationBundle(withBody("x".repeat(CUSTOM_SCRIPT_MAX))).ok).toBe(true);
    expect(parseAutomationBundle(withBody("x".repeat(CUSTOM_SCRIPT_MAX + 1))).ok).toBe(false);
    expect(parseAutomationBundle(withBody("  \n")).ok).toBe(false);
  });

  it("gives a script no tool slots, like a command", () => {
    const file = { ...automationBundle(scripted()), slots: [{ name: "jira", label: "Jira", description: "" }] };
    expect(parseAutomationBundle(file)).toMatchObject({ ok: false, error: expect.stringMatching(/Only an agent/) });
  });

  it("writes the newest version for a command with inputs or an action that reads a variable, and the oldest otherwise", () => {
    const shell = (extra: Record<string, unknown> = {}) =>
      automationBundle({ ...definition(), action: CustomAction.parse({ kind: "shell", command: "make", ...extra }) });
    expect(shell().version).toBe(PLAIN_BUNDLE_VERSION);
    expect(shell({ inputs: [{ name: "days", label: "Days" }] }).version).toBe(AUTOMATION_BUNDLE_VERSION);
    const agent = CustomAction.parse({ kind: "agent", prompt: "Triage {{vars.jira_key}}" });
    expect(automationBundle({ ...definition(), action: agent }).version).toBe(AUTOMATION_BUNDLE_VERSION);
  });

  it("carries a script's inputs as declarations and fills them on import", () => {
    const withInputs = scripted();
    const action = CustomAction.parse({
      ...withInputs.action,
      inputs: [{ name: "days", label: "Days", type: "number", default: "7", value: "14" }],
    });
    const file = automationBundle({ ...withInputs, action });
    expect(file.action).toMatchObject({ inputs: [] });
    expect(file.inputs).toEqual([{ name: "days", label: "Days", type: "number", default: "14" }]);
    // A board from before inputs on scripts would refuse the file as invalid, so it says it is newer.
    expect(file.version).toBe(AUTOMATION_BUNDLE_VERSION);
    expect(parseAutomationBundle({ ...file, version: SCRIPT_BUNDLE_VERSION })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/need a version 3 file/),
    });
    const parsed = parseAutomationBundle(JSON.parse(JSON.stringify(file)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(bundleToDefinition(parsed.bundle, { inputs: { days: "30" } }).action).toMatchObject({
      kind: "script",
      inputs: [{ name: "days", value: "30" }],
    });
  });

  it("lists the scripts an action runs: its own body, or an agent's check", () => {
    expect(actionScripts(CustomAction.parse(script))).toEqual([
      { role: "script", script: expect.objectContaining({ language: "python", body: script.body }) },
    ]);
    expect(actionScripts(CustomAction.parse({ kind: "shell", command: "make" }))).toEqual([]);
    const agent = definition().action;
    expect(actionScripts(agent)).toEqual([]);
    const check = { language: "node", body: "console.log(1)", timeoutSeconds: 60 };
    expect(actionScripts(withCheck(agent, check))).toEqual([{ role: "check", script: check }]);
    expect(actionScripts(withCheck(agent, { language: "ruby", body: "x" }))).toEqual([]);
  });

  it("counts a command, a script and a check script as code, and a plain agent as none", () => {
    expect(actionRunsCode(CustomAction.parse({ kind: "shell", command: "make" }))).toBe(true);
    expect(actionRunsCode(CustomAction.parse(script))).toBe(true);
    expect(actionRunsCode(withCheck(definition().action, { language: "sh", body: "ls" }))).toBe(true);
    expect(actionRunsCode(definition().action)).toBe(false);
  });
});
