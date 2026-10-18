import {
  type AutomationBundle,
  bundleToDefinition,
  checkCustomDefinition,
  CreateCustomAutomationInput,
  type ImportAutomationInput,
  parseAutomationBundle,
} from "@repo/contracts";
import { parseAllowedTools } from "./customAutomations.logic";

/** What the importer fills in on top of the file. Slot tools are as typed, one per line. */
export interface ImportDraft {
  inputs: Record<string, string>;
  slots: Record<string, string>;
  projectIds: string[];
  installSkill: boolean;
}

/** A file's text as a bundle, or what is wrong with it. */
export function readBundle(text: string): { ok: true; bundle: AutomationBundle } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "This isn't a JSON file" };
  }
  return parseAutomationBundle(json);
}

/** The inputs at the author's defaults, no tools, no projects, and the skill (if any) not installed until agreed to. */
export function initialDraft(bundle: AutomationBundle): ImportDraft {
  return {
    inputs: Object.fromEntries(bundle.inputs.map((input) => [input.name, input.default])),
    slots: Object.fromEntries(bundle.slots.map((slot) => [slot.name, ""])),
    projectIds: [],
    installSkill: false,
  };
}

/** What the server is sent. */
export function draftToRequest(bundle: AutomationBundle, draft: ImportDraft): ImportAutomationInput {
  return {
    bundle,
    inputs: draft.inputs,
    slots: Object.fromEntries(Object.entries(draft.slots).map(([name, text]) => [name, parseAllowedTools(text)])),
    projectIds: draft.projectIds,
    installSkill: draft.installSkill,
  };
}

/** Why this can't be imported as filled in (the server's checks, run first), or null. An empty slot is allowed. */
export function importProblem(bundle: AutomationBundle, draft: ImportDraft): string | null {
  const request = draftToRequest(bundle, draft);
  const parsed = CreateCustomAutomationInput.safeParse(
    bundleToDefinition(bundle, {
      inputs: request.inputs,
      slots: request.slots,
      projectIds: request.projectIds,
      // The name only has to be a skill's for the check; the real one is whatever the install gives.
      skill: bundle.skill?.name ?? null,
    }),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const slot = issue.path.indexOf("slots");
    const n = slot >= 0 ? issue.path[slot + 1] : undefined;
    return typeof n === "number" ? `${bundle.slots[n]?.label ?? "Tool slot"}: ${issue.message}` : issue.message;
  }
  return checkCustomDefinition(parsed.data);
}

/** The file name a download of an automation gets: `dispatch.automation.json`. */
export function bundleFilename(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "automation"}.automation.json`;
}
