import { AUTOMATION_EXAMPLES, type AutomationBundle } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  bundleFilename,
  draftToRequest,
  importProblem,
  initialDraft,
  readBundle,
} from "./customAutomationImport.logic";

const dispatch = (): AutomationBundle => AUTOMATION_EXAMPLES.find((e) => e.id === "dispatch")!.bundle;

describe("reading a file", () => {
  it("takes a bundle's JSON and says what is wrong with anything else", () => {
    expect(readBundle(JSON.stringify(dispatch()))).toMatchObject({ ok: true, bundle: { name: "Dispatch" } });
    expect(readBundle("not json")).toEqual({ ok: false, error: "This isn't a JSON file" });
    expect(readBundle("{}")).toMatchObject({ ok: false, error: expect.stringMatching(/automation file/) });
    expect(readBundle(JSON.stringify({ ...dispatch(), version: 99 }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/newer/),
    });
  });
});

describe("filling in an import", () => {
  it("starts from the author's input values, no tools, no projects and no skill", () => {
    expect(initialDraft(dispatch())).toEqual({
      inputs: {
        jql: "issuetype = Bug AND resolution = Unresolved",
        look_back_days: "14",
        max_issues: "50",
        require_approval: "true",
      },
      slots: { jira: "" },
      projectIds: [],
      installSkill: false,
    });
  });

  it("sends a slot's tools one per line as a list", () => {
    const bundle = dispatch();
    const request = draftToRequest(bundle, {
      ...initialDraft(bundle),
      slots: { jira: " mcp__issue-tracker__search_jira \n\nmcp__issue-tracker__get_jira_issue\n" },
    });
    expect(request.slots).toEqual({ jira: ["mcp__issue-tracker__search_jira", "mcp__issue-tracker__get_jira_issue"] });
  });

  it("allows an empty slot (it comes in blocked) but not a value or tool that can't work", () => {
    const bundle = dispatch();
    const draft = initialDraft(bundle);
    expect(importProblem(bundle, draft)).toBeNull();
    expect(importProblem(bundle, { ...draft, inputs: { ...draft.inputs, max_issues: "lots" } })).toMatch(
      /enter a number/,
    );
    expect(importProblem(bundle, { ...draft, slots: { jira: "Bash" } })).toMatch(/^Jira tools: /);
  });
});

describe("bundleFilename", () => {
  it("makes a safe file name from the automation's name", () => {
    expect(bundleFilename("Dispatch")).toBe("dispatch.automation.json");
    expect(bundleFilename(" Fix: checks / CI! ")).toBe("fix-checks-ci.automation.json");
    expect(bundleFilename("***")).toBe("automation.automation.json");
  });
});
