import { z } from "zod";
import {
  AUTOMATION_BUNDLE_FORMAT,
  AUTOMATION_BUNDLE_VERSION,
  AutomationBundle,
  bundleToDefinition,
  parseAutomationBundle,
} from "./automationBundle.ts";
import { checkCustomDefinition, CreateCustomAutomationInput } from "./customAutomations.ts";
import { normalizeLabels } from "./labels.ts";

// Automations an agent drafted over MCP for the user to review and import (docs/features/autopilot.md#drafts). A draft
// is a shared file waiting on the import page: the agent writes it, only the user's import saves an automation.

/** A draft not imported or dismissed by then is dropped. */
export const AUTOMATION_DRAFT_TTL_DAYS = 14;
/** The most drafts kept at once; past it the oldest go. */
export const AUTOMATION_DRAFTS_MAX = 20;
export const AUTOMATION_DRAFT_NOTE_MAX = 2_000;
/** As JSON, the same cap as a file picked on the import page. */
export const AUTOMATION_DRAFT_BYTES_MAX = 500_000;

/** What the agent sends: the automation in the shape of a shared file, and a note to the user. */
export const DraftAutomationInput = z.object({
  /** An `AutomationBundle`; `format` and `version` may be left out and are filled in. */
  automation: z.record(z.string(), z.unknown()),
  /** What it is for and anything the user should check, shown above it on the import page. */
  note: z.string().trim().max(AUTOMATION_DRAFT_NOTE_MAX).default(""),
  /**
   * The custom automation this is a new version of: its id, its key (`custom:<id>`) or its name. Applying the draft
   * then changes that automation in place, keeping its id, switches and run history.
   */
  replaces: z.string().trim().min(1).optional(),
});
export type DraftAutomationInput = z.input<typeof DraftAutomationInput>;

/** A draft waiting for the user. Never backed up: it is a hand-off, not the user's data. */
export interface AutomationDraft {
  id: string;
  bundle: AutomationBundle;
  note: string;
  /** The id of the custom automation it proposes a new version of, or null for a new automation. */
  replaces: string | null;
  /** The actor that drafted it, e.g. `claude-code`. */
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

/** What applying a draft that replaces an automation sends: what the reader filled in for what is new in it. */
export const ApplyAutomationDraftInput = z.object({
  /** Values for inputs; one left out keeps the automation's current value, or a new input's default. */
  inputs: z.record(z.string(), z.string()).default({}),
  /** Tools for slots; one left out keeps the automation's current tools for a slot of that name. */
  slots: z.record(z.string(), z.array(z.string())).default({}),
  /** Write the draft's skill into the user's skills. Only after they've seen it. */
  installSkill: z.boolean().default(false),
  /** The reader has read the changed scripts and agrees they run on their machine. Required when a script changed. */
  confirmScript: z.boolean().default(false),
});
export type ApplyAutomationDraftInput = z.input<typeof ApplyAutomationDraftInput>;

/** Where the user reviews and imports a draft, relative to the board's URL. */
export const automationDraftPath = (id: string): string =>
  `/settings/autopilot/custom/import?draft=${encodeURIComponent(id)}`;

/**
 * The draft as a file the import page takes, or every problem with it, each with where it is, so an agent can fix them
 * all and send it again. Runs the checks an import runs on the definition, with the inputs at their defaults and the
 * slots empty, so a draft that passes can be imported once the user fills them in.
 */
export function checkAutomationDraft(
  automation: Record<string, unknown>,
): { ok: true; bundle: AutomationBundle } | { ok: false; errors: string[] } {
  const raw = { format: AUTOMATION_BUNDLE_FORMAT, version: AUTOMATION_BUNDLE_VERSION, ...automation };
  if (JSON.stringify(raw).length > AUTOMATION_DRAFT_BYTES_MAX) {
    return { ok: false, errors: [`The automation is over ${AUTOMATION_DRAFT_BYTES_MAX} characters as JSON`] };
  }
  // A newer `version` is told as such rather than as a malformed body.
  if (typeof raw.version === "number" && raw.version > AUTOMATION_BUNDLE_VERSION) {
    const newer = parseAutomationBundle(raw);
    if (!newer.ok) return { ok: false, errors: [newer.error] };
  }
  const parsed = AutomationBundle.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) =>
        issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      ),
    };
  }
  const bundle = parsed.data;
  try {
    normalizeLabels(bundle.filters.labels);
  } catch (error) {
    return { ok: false, errors: [`filters.labels: ${(error as Error).message}`] };
  }
  const def = CreateCustomAutomationInput.safeParse(bundleToDefinition(bundle));
  if (!def.success) {
    return { ok: false, errors: def.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
  }
  const problem = checkCustomDefinition(def.data);
  return problem ? { ok: false, errors: [problem] } : { ok: true, bundle };
}
