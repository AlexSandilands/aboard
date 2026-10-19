import { z } from "zod";
import { BRAND } from "./brand.ts";
import {
  AutomationInputDecl,
  AutomationSlotDecl,
  CUSTOM_INPUTS_MAX,
  CUSTOM_NAME_MAX,
  CUSTOM_SLOTS_MAX,
  CustomAction,
  CustomScript,
  CustomTrigger,
  type CreateCustomAutomationInput,
  type CustomAutomation,
  type CustomDefinition,
} from "./customAutomations.ts";

// A custom automation as a file someone can share and anyone can import (docs/features/autopilot.md#sharing-automations). The
// file holds the definition without what is the sharer's own: their projects, their epic, when it was armed, and the
// tools they filled its slots with (people use different MCP servers). It declares the inputs the importer fills in and
// the tool slots they fill with tools of their own.

export const AUTOMATION_BUNDLE_FORMAT = `${BRAND.id}.automation`;
/** Every file without a script, so a board from before scripts reads what a newer one writes. */
export const PLAIN_BUNDLE_VERSION = 1 as const;
/**
 * The newest version this board reads, and the one a file carrying a script is written as: an older board would drop a
 * check script and refuse a script action. Bumped when the file's shape changes in a way an older reader can't take.
 */
export const AUTOMATION_BUNDLE_VERSION = 2 as const;
export const BUNDLE_SKILL_BODY_MAX = 100_000;

/** A skill carried in the file by its text, written to the importer's skills on import after they confirm. */
export const BundleSkill = z.object({
  /** The folder it is written to, so no path characters. */
  name: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "Use letters, digits, - and _ in a skill's name"),
  /** The whole `SKILL.md`. */
  body: z.string().min(1).max(BUNDLE_SKILL_BODY_MAX),
});
export type BundleSkill = z.infer<typeof BundleSkill>;

/** A script a file carries: the action itself, or the check an agent runs first. */
export interface BundleScript {
  role: "script" | "check";
  script: CustomScript;
}

/**
 * Every script an action would run, in the order a reader should see them. An agent's `check` is parsed here too, so
 * the places that guard or confirm scripts don't depend on the action schema having kept it.
 */
export function actionScripts(action: CustomAction): BundleScript[] {
  if (action.kind === "script") return [{ role: "script", script: action }];
  if (action.kind !== "agent") return [];
  const check = CustomScript.safeParse((action as { check?: unknown }).check);
  return check.success ? [{ role: "check", script: check.data }] : [];
}

/** Whether saving this action sets up something that runs as the user: a command, a script or a check script. */
export const actionRunsCode = (action: CustomAction): boolean =>
  action.kind === "shell" || actionScripts(action).length > 0;

/** The version a file for this action is written as: the oldest that can hold it. */
export const bundleVersionFor = (action: CustomAction): AutomationBundle["version"] =>
  actionScripts(action).length > 0 ? AUTOMATION_BUNDLE_VERSION : PLAIN_BUNDLE_VERSION;

export const AutomationBundle = z
  .object({
    format: z.literal(AUTOMATION_BUNDLE_FORMAT),
    version: z.union([z.literal(PLAIN_BUNDLE_VERSION), z.literal(AUTOMATION_BUNDLE_VERSION)]),
    name: z.string().trim().min(1).max(CUSTOM_NAME_MAX),
    /** What it does, for the person importing it. */
    description: z.string().trim().max(1_000).default(""),
    trigger: CustomTrigger,
    /** Only what travels: the projects and the epic are the sharer's. */
    filters: z.object({ labels: z.array(z.string().trim().min(1)).default([]) }).default({ labels: [] }),
    /** An agent's own `inputs` and `slots` are ignored: they are declared next to it. */
    action: CustomAction,
    inputs: z.array(AutomationInputDecl).max(CUSTOM_INPUTS_MAX).default([]),
    slots: z.array(AutomationSlotDecl).max(CUSTOM_SLOTS_MAX).default([]),
    /** The skill the action names, when the sharer included it. */
    skill: BundleSkill.optional(),
  })
  .superRefine((bundle, ctx) => {
    if (bundle.action.kind !== "agent" && (bundle.inputs.length > 0 || bundle.slots.length > 0)) {
      ctx.addIssue({ code: "custom", message: "Only an agent can have inputs or tool slots", path: ["action"] });
    }
    // A version 1 reader would read this as a file without its script, so it must say it is a newer one.
    if (bundle.version < AUTOMATION_BUNDLE_VERSION && actionScripts(bundle.action).length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `A script needs a version ${AUTOMATION_BUNDLE_VERSION} file`,
        path: ["version"],
      });
    }
  });
export type AutomationBundle = z.infer<typeof AutomationBundle>;

const Header = z.object({ format: z.literal(AUTOMATION_BUNDLE_FORMAT), version: z.number().int().min(1) });

/** The file's contents as a bundle, or what is wrong with it. A file from a newer version is refused as such. */
export function parseAutomationBundle(
  json: unknown,
): { ok: true; bundle: AutomationBundle } | { ok: false; error: string } {
  const header = Header.safeParse(json);
  if (!header.success) return { ok: false, error: `This isn't a ${BRAND.name} automation file` };
  if (header.data.version > AUTOMATION_BUNDLE_VERSION) {
    return {
      ok: false,
      error: `This file is version ${header.data.version}, made by a newer ${BRAND.name}. Update to import it.`,
    };
  }
  const parsed = AutomationBundle.safeParse(json);
  if (parsed.success) return { ok: true, bundle: parsed.data };
  const issue = parsed.error.issues[0]!;
  const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return { ok: false, error: `The automation file is invalid (${where}${issue.message})` };
}

/**
 * The file for an automation: its inputs with their current values as the defaults and its slots without tools.
 * `skill` is the text of the skill the action names, when it is found and should travel with it.
 */
export function automationBundle(
  def: Pick<CustomDefinition, "name" | "trigger" | "filters" | "action">,
  skill: BundleSkill | null = null,
): AutomationBundle {
  const { action } = def;
  return {
    format: AUTOMATION_BUNDLE_FORMAT,
    version: bundleVersionFor(action),
    name: def.name,
    description: "",
    trigger: def.trigger,
    filters: { labels: def.filters.labels },
    action: action.kind === "agent" ? { ...action, inputs: [], slots: [] } : action,
    inputs:
      action.kind === "agent"
        ? action.inputs.map(({ name, label, type, value }) => ({ name, label, type, default: value }))
        : [],
    slots:
      action.kind === "agent" ? action.slots.map(({ name, label, description }) => ({ name, label, description })) : [],
    ...(skill && action.kind === "agent" ? { skill } : {}),
  };
}

/** What an input starts at on import: its default, except that a yes / no input with none starts at no. */
export const inputStartValue = (input: Pick<AutomationInputDecl, "type" | "default">): string =>
  input.type === "boolean" && input.default === "" ? "false" : input.default;

/** What the importer chooses on top of the file. */
export interface BundleFill {
  /** Input values by name; an input left out takes its default. */
  inputs?: Record<string, string>;
  /** The tools filling each slot by name; a slot left out stays empty. */
  slots?: Record<string, readonly string[]>;
  /** The projects to restrict it to; none is every project it is switched on in. */
  projectIds?: readonly string[];
  /**
   * The skill the action ends up naming. Leave it out to keep what the file says, except that a file with a skill of
   * its own and no installed copy names none: null clears it.
   */
  skill?: string | null;
}

/** The definition to save for an imported file. Unchecked: run it through `checkCustomDefinition` like any other. */
export function bundleToDefinition(bundle: AutomationBundle, fill: BundleFill = {}): CreateCustomAutomationInput {
  const { action } = bundle;
  return {
    name: bundle.name,
    trigger: bundle.trigger,
    filters: { projectIds: [...(fill.projectIds ?? [])], labels: bundle.filters.labels, epicId: null },
    action:
      action.kind === "agent"
        ? {
            ...action,
            skill: fill.skill !== undefined ? (fill.skill ?? "") : bundle.skill ? "" : action.skill,
            inputs: bundle.inputs.map((input) => ({
              ...input,
              value: fill.inputs?.[input.name] ?? inputStartValue(input),
            })),
            slots: bundle.slots.map((slot) => ({ ...slot, tools: [...(fill.slots?.[slot.name] ?? [])] })),
          }
        : action,
  };
}

/** What importing sends: the file, what the importer filled in, and whether to write the file's skill. */
export const ImportAutomationInput = z.object({
  /** Checked by `parseAutomationBundle`, so a file from a newer version is told so rather than refused as malformed. */
  bundle: z.unknown(),
  inputs: z.record(z.string(), z.string()).default({}),
  slots: z.record(z.string(), z.array(z.string())).default({}),
  projectIds: z.array(z.string().min(1)).default([]),
  /** Write the file's skill into the user's skills. Only after they've seen it. */
  installSkill: z.boolean().default(false),
  /** The importer has read the file's scripts and agrees they run on their machine. Required when it has one. */
  confirmScript: z.boolean().default(false),
});
export type ImportAutomationInput = z.input<typeof ImportAutomationInput>;

/** A skill written by an import. `renamed` when the file's name was taken. */
export interface InstalledSkill {
  name: string;
  path: string;
  renamed: boolean;
}

/** What an import made: the automation, and the skill written for it when there was one. */
export interface ImportedAutomation {
  automation: CustomAutomation;
  skill: InstalledSkill | null;
}
