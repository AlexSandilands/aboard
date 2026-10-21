import {
  AUTOMATION_BUNDLE_FORMAT,
  AutomationBundle,
  automationBundle,
  CustomAction,
  PLAIN_BUNDLE_VERSION,
} from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  bundleFilename,
  draftToRequest,
  importProblem,
  initialDraft,
  needsScriptConfirm,
  readBundle,
} from "./customAutomationImport.logic";

const triage = (): AutomationBundle =>
  AutomationBundle.parse({
    format: AUTOMATION_BUNDLE_FORMAT,
    version: PLAIN_BUNDLE_VERSION,
    name: "Triage",
    trigger: { kind: "schedule", schedule: { kind: "hourly", everyHours: 1 } },
    action: { kind: "agent", prompt: "Triage the issues {{inputs.jql}} finds." },
    inputs: [
      { name: "jql", label: "Which issues", type: "text", default: "issuetype = Bug AND resolution = Unresolved" },
      { name: "look_back_days", label: "Look back (days)", type: "number", default: "14" },
      { name: "max_issues", label: "Most issues per run", type: "number", default: "50" },
      { name: "require_approval", label: "Require a human to approve plans first", type: "boolean", default: "true" },
    ],
    slots: [{ name: "jira", label: "Jira tools", description: "search issues by JQL and read an issue" }],
  });

describe("reading a file", () => {
  it("takes a bundle's JSON and says what is wrong with anything else", () => {
    expect(readBundle(JSON.stringify(triage()))).toMatchObject({ ok: true, bundle: { name: "Triage" } });
    expect(readBundle("not json")).toEqual({ ok: false, error: "This isn't a JSON file" });
    expect(readBundle("{}")).toMatchObject({ ok: false, error: expect.stringMatching(/automation file/) });
    expect(readBundle(JSON.stringify({ ...triage(), version: 99 }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/newer/),
    });
  });
});

describe("filling in an import", () => {
  it("starts from the author's input values, no tools, no projects and no skill", () => {
    expect(initialDraft(triage())).toEqual({
      inputs: {
        jql: "issuetype = Bug AND resolution = Unresolved",
        look_back_days: "14",
        max_issues: "50",
        require_approval: "true",
      },
      slots: { jira: "" },
      projectIds: [],
      installSkill: false,
      confirmScript: false,
    });
  });

  it("sends a slot's tools one per line as a list", () => {
    const bundle = triage();
    const request = draftToRequest(bundle, {
      ...initialDraft(bundle),
      slots: { jira: " mcp__issue-tracker__search_jira \n\nmcp__issue-tracker__get_jira_issue\n" },
    });
    expect(request.slots).toEqual({ jira: ["mcp__issue-tracker__search_jira", "mcp__issue-tracker__get_jira_issue"] });
  });

  it("allows an empty slot (it comes in blocked) but not a value or tool that can't work", () => {
    const bundle = triage();
    const draft = initialDraft(bundle);
    expect(importProblem(bundle, draft)).toBeNull();
    expect(importProblem(bundle, { ...draft, inputs: { ...draft.inputs, max_issues: "lots" } })).toMatch(
      /enter a number/,
    );
    expect(importProblem(bundle, { ...draft, slots: { jira: "Bash" } })).toMatch(/^Jira tools: /);
  });
});

describe("a file with a script", () => {
  const scripted = (): AutomationBundle =>
    automationBundle({
      name: "Check",
      trigger: { kind: "schedule", schedule: { kind: "hourly", everyHours: 1 } },
      filters: { projectIds: [], labels: [], epicId: null },
      action: CustomAction.parse({ kind: "script", language: "sh", body: "echo hi" }),
    });

  it("can't be imported until the importer confirms, and sends the confirmation", () => {
    const bundle = scripted();
    const draft = initialDraft(bundle);
    expect(needsScriptConfirm(bundle, draft)).toBe(true);
    expect(draftToRequest(bundle, draft).confirmScript).toBe(false);
    const confirmed = { ...draft, confirmScript: true };
    expect(needsScriptConfirm(bundle, confirmed)).toBe(false);
    expect(draftToRequest(bundle, confirmed).confirmScript).toBe(true);
    expect(importProblem(bundle, confirmed)).toBeNull();
  });

  it("names the agent's draft it came from, so the import deletes it", () => {
    const bundle = scripted();
    expect(draftToRequest(bundle, initialDraft(bundle), "draft-1").draftId).toBe("draft-1");
    expect(draftToRequest(bundle, initialDraft(bundle))).not.toHaveProperty("draftId");
  });

  it("is read from a file, and a file without a script needs no confirmation", () => {
    expect(readBundle(JSON.stringify(scripted()))).toMatchObject({ ok: true, bundle: { version: 2 } });
    expect(needsScriptConfirm(triage(), initialDraft(triage()))).toBe(false);
  });
});

describe("bundleFilename", () => {
  it("makes a safe file name from the automation's name", () => {
    expect(bundleFilename("Triage")).toBe("triage.automation.json");
    expect(bundleFilename(" Fix: checks / CI! ")).toBe("fix-checks-ci.automation.json");
    expect(bundleFilename("***")).toBe("automation.automation.json");
  });
});
