import {
  actionScripts,
  bundleToDefinition,
  CreateCustomAutomationInput,
  customAllowedTools,
  describeCustomTrigger,
  type AutomationBundle,
  type CustomAutomation,
  type CustomDefinition,
  type ModelProfile,
} from "@repo/contracts";
import { actionModelLabel } from "./customAutomations.logic";

// A draft that replaces a custom automation (draft_automation's `replaces`, docs/features/autopilot.md#drafts): what the
// automation would become if applied, and the difference field by field, for the before/after review.

/** Whether the draft carries a skill of the name the automation already uses, so not saving it keeps the user's own. */
export const keepsSkill = (current: CustomAutomation, bundle: AutomationBundle): boolean =>
  current.action.kind === "agent" && bundle.skill?.name === current.action.skill;

/**
 * The definition applying the draft saves, as the server builds it: the draft's, with the inputs' and slots' current
 * values kept by name, the automation's own projects and epic, and the skill applying would name.
 * `fill` is what the reader typed for inputs and slots that are new.
 */
export function proposedDefinition(
  current: CustomAutomation,
  bundle: AutomationBundle,
  fill: {
    inputs?: Record<string, string>;
    slots?: Record<string, readonly string[]>;
    /** Whether the reader chose to save the skill the draft carries; the server then names the copy it writes. */
    installSkill?: boolean;
  } = {},
): CustomDefinition {
  const values = new Map(current.action.inputs.map((i) => [i.name, i.value]));
  const tools = new Map(current.action.kind === "agent" ? current.action.slots.map((s) => [s.name, s.tools]) : []);
  const def = CreateCustomAutomationInput.parse(
    bundleToDefinition(bundle, {
      inputs: Object.fromEntries(
        bundle.inputs.flatMap((i) => {
          const value = fill.inputs?.[i.name] ?? values.get(i.name);
          return value === undefined ? [] : [[i.name, value]];
        }),
      ),
      slots: Object.fromEntries(bundle.slots.map((s) => [s.name, fill.slots?.[s.name] ?? tools.get(s.name) ?? []])),
      // As applying names it: the draft's skill once saved, the automation's own when the names match, else none.
      ...(bundle.skill ? { skill: fill.installSkill || keepsSkill(current, bundle) ? bundle.skill.name : null } : {}),
    }),
  );
  // Where it runs is its switches, which applying leaves alone.
  const { name, trigger, filters, action } = def;
  return { name, trigger, filters, action };
}

/** One field the draft changes, as text before and after, for a line diff. */
export interface FieldChange {
  title: string;
  before: string;
  after: string;
}

const ACTION_LABEL = { agent: "Ask an agent", shell: "Run a command", script: "Run a script" } as const;
const yesNo = (value: boolean) => (value ? "Yes" : "No");

/** Each field of a definition as text, in the order the review lists them. Fields an action doesn't have are "". */
function fieldsOf(def: CustomDefinition, profiles: readonly Pick<ModelProfile, "id" | "name">[]): FieldChange[] {
  const { action } = def;
  const isSchedule = def.trigger.kind === "schedule";
  const agent = action.kind === "agent" ? action : null;
  const check = actionScripts(action).find((s) => s.role === "check")?.script;
  const field = (title: string, text: string) => ({ title, before: "", after: text });
  return [
    field("Name", def.name),
    field("Trigger", describeCustomTrigger(def.trigger)),
    field("Labels", def.filters.labels.join(", ")),
    field("Action", ACTION_LABEL[action.kind]),
    field("Prompt", agent?.prompt ?? ""),
    field("Command", action.kind === "shell" ? action.command : ""),
    field("Script", action.kind === "script" ? `${action.language}\n${action.body}` : ""),
    field("Check script", check ? `${check.language}, stops after ${check.timeoutSeconds} s\n${check.body}` : ""),
    field("Items are untrusted", agent && check ? yesNo(agent.untrustedItems) : ""),
    field("Timeout", action.kind === "agent" ? "" : `${action.timeoutSeconds} s`),
    field("Model", agent ? actionModelLabel(agent.model, profiles, isSchedule) : ""),
    field("Skill", agent?.skill ?? ""),
    field("Works on the PR's branch", agent && !isSchedule ? yesNo(agent.onPrBranch) : ""),
    field("Allowed tools", agent ? agent.allowedTools.join("\n") : ""),
    field(
      "Inputs",
      action.inputs.map((i) => `${i.label} (${i.name}, ${i.type}): ${i.value === "" ? "empty" : i.value}`).join("\n"),
    ),
    field(
      "Required tools",
      agent
        ? agent.slots.map((s) => `${s.label} (${s.name})${s.description ? `: ${s.description}` : ""}`).join("\n")
        : "",
    ),
  ];
}

/** The fields that differ between the automation and what the draft would make it, in the review's order. */
export function automationChanges(
  current: CustomDefinition,
  proposed: CustomDefinition,
  profiles: readonly Pick<ModelProfile, "id" | "name">[] = [],
): FieldChange[] {
  const before = fieldsOf(current, profiles);
  const after = fieldsOf(proposed, profiles);
  return before.flatMap((field, i) => {
    const next = after[i]!.after;
    return field.after === next ? [] : [{ title: field.title, before: field.after, after: next }];
  });
}

/** Whether applying runs a script that isn't the one the automation runs now, so the reader must confirm it. */
export const changesScripts = (current: CustomDefinition, proposed: CustomDefinition): boolean =>
  actionScripts(proposed.action).length > 0 &&
  JSON.stringify(actionScripts(proposed.action)) !== JSON.stringify(actionScripts(current.action));

/** Tools the change lets the agent use that it can't today, for a warning. */
export function addedTools(current: CustomDefinition, proposed: CustomDefinition): string[] {
  const now = new Set(current.action.kind === "agent" ? customAllowedTools(current.action) : []);
  return proposed.action.kind === "agent" ? customAllowedTools(proposed.action).filter((t) => !now.has(t)) : [];
}
