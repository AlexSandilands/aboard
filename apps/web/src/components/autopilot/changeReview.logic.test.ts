import {
  AUTOMATION_BUNDLE_FORMAT,
  automationBundle,
  CreateCustomAutomationInput,
  type AutomationBundle,
  type CustomAutomation,
} from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { addedTools, automationChanges, changesScripts, proposedDefinition } from "./changeReview.logic";

const current: CustomAutomation = {
  id: "c-1",
  ...CreateCustomAutomationInput.parse({
    name: "Flaky test report",
    trigger: { kind: "schedule", schedule: { kind: "weekly", days: [1], time: "08:00" } },
    filters: { projectIds: ["p1"] },
    action: {
      kind: "agent",
      prompt: "Open a task for {{item.key}}.",
      inputs: [{ name: "days", label: "Days", type: "number", value: "3", default: "7" }],
      slots: [{ name: "ci", label: "CI logs", tools: ["mcp__ci__logs"] }],
      check: { language: "node", body: "// v1\n" },
      untrustedItems: false,
    },
  }),
  armedAt: "2026-11-01T00:00:00.000Z",
  armedProjects: {},
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

/** The automation's own file with some of it changed, as an agent would send it back. */
const draft = (change: (bundle: AutomationBundle) => AutomationBundle): AutomationBundle =>
  change(automationBundle(current));

describe("proposedDefinition", () => {
  it("keeps the automation's input values, slot tools, projects and epic", () => {
    const next = proposedDefinition(
      current,
      draft((b) => ({
        ...b,
        inputs: [...b.inputs, { name: "branch", label: "Branch", type: "text", default: "main" }],
      })),
    );
    expect(next.filters.projectIds).toEqual(["p1"]);
    expect(next.action.inputs.map((i) => [i.name, i.value])).toEqual([
      ["days", "3"],
      ["branch", "main"],
    ]);
    expect(next.action.kind === "agent" && next.action.slots[0]!.tools).toEqual(["mcp__ci__logs"]);
  });
});

describe("the skill a change names", () => {
  const withSkill = (name: string): CustomAutomation =>
    ({ ...current, action: { ...current.action, skill: name } }) as CustomAutomation;
  const carrying = (name: string) => draft((b) => ({ ...b, skill: { name, body: "# A skill" } }));
  const skillOf = (def: ReturnType<typeof proposedDefinition>) =>
    def.action.kind === "agent" ? def.action.skill : null;

  it("names the draft's skill only once the reader saves it, as applying does", () => {
    expect(skillOf(proposedDefinition(withSkill("triage"), carrying("flaky")))).toBe("");
    expect(skillOf(proposedDefinition(withSkill("triage"), carrying("flaky"), { installSkill: true }))).toBe("flaky");
  });

  it("keeps the automation's own skill when the draft carries one of the same name and it isn't saved", () => {
    expect(skillOf(proposedDefinition(withSkill("triage"), carrying("triage")))).toBe("triage");
  });
});

describe("automationChanges", () => {
  it("is empty for the automation's own file", () => {
    expect(
      automationChanges(
        current,
        proposedDefinition(
          current,
          draft((b) => b),
        ),
      ),
    ).toEqual([]);
  });

  it("lists only the fields that differ, before and after", () => {
    const bundle = draft((b) => ({
      ...b,
      format: AUTOMATION_BUNDLE_FORMAT,
      trigger: { kind: "schedule", schedule: { kind: "weekly", days: [1, 4], time: "08:00" } },
      action:
        b.action.kind === "agent"
          ? {
              ...b.action,
              prompt: "Open a task for {{item.key}}.\nLink the failing runs.",
              check: { language: "node", body: "// v2\n", timeoutSeconds: 300 },
              allowedTools: ["mcp__gh"],
            }
          : b.action,
    }));
    const next = proposedDefinition(current, bundle);
    const changes = automationChanges(current, next);

    expect(changes.map((c) => c.title)).toEqual(["Trigger", "Prompt", "Check script", "Allowed tools"]);
    expect(changes[0]).toEqual({ title: "Trigger", before: "Mon at 08:00", after: "Mon, Thu at 08:00" });
    expect(changesScripts(current, next)).toBe(true);
    expect(addedTools(current, next)).toEqual(["mcp__gh"]);
  });

  it("doesn't ask to confirm a script that is unchanged", () => {
    const next = proposedDefinition(
      current,
      draft((b) => ({
        ...b,
        action: b.action.kind === "agent" ? { ...b.action, prompt: "Something else." } : b.action,
      })),
    );
    expect(changesScripts(current, next)).toBe(false);
  });
});
