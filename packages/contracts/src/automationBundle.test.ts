import { describe, expect, it } from "vitest";
import {
  AUTOMATION_BUNDLE_FORMAT,
  AUTOMATION_BUNDLE_VERSION,
  automationBundle,
  bundleToDefinition,
  inputStartValue,
  parseAutomationBundle,
} from "./automationBundle.ts";
import {
  checkCustomDefinition,
  CreateCustomAutomationInput,
  CustomAction,
  CustomTrigger,
  type CustomDefinition,
} from "./customAutomations.ts";

const definition = (): CustomDefinition => ({
  name: "Dispatch",
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
      version: AUTOMATION_BUNDLE_VERSION,
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
