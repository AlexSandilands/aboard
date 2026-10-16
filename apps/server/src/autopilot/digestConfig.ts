import { BRAND, DigestMode, ReviewSkillRef, type AutopilotField } from "@repo/contracts";
import { z } from "zod";

// The digest automation's config (docs/features/autopilot.md#automations), apart from the automation so
// the generator can read it without a cycle.

/** The name the picker gives the board's own digest skill. */
export const BUILTIN_DIGEST_SKILL_NAME = `${BRAND.id}-digest`;

export const DigestConfig = z.object({
  mode: DigestMode,
  /** Local time of the daily digest. */
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)"),
  weekdaysOnly: z.boolean(),
  /** What the summarising agent follows. */
  skill: ReviewSkillRef,
  /** The agent's budget, in USD. */
  budgetUsd: z.number().positive().max(100),
  timeoutMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  /** `claude --model`; blank takes the light tier's model when it maps to a Claude model. */
  model: z.string(),
});
export type DigestConfig = z.infer<typeof DigestConfig>;

export const DIGEST_DEFAULTS: DigestConfig = {
  mode: "plain",
  time: "09:00",
  weekdaysOnly: false,
  skill: { source: "builtin" },
  budgetUsd: 1,
  timeoutMinutes: 15,
  model: "",
};

export const DIGEST_FIELDS: AutopilotField[] = [
  {
    key: "mode",
    label: "Digest",
    kind: "select",
    help: "Plain is a grouped list the board builds. Summarised has an agent write it up, and falls back to plain if that fails.",
    options: [
      { value: "plain", label: "Plain list (no agent)" },
      { value: "summarised", label: "Written by an agent" },
    ],
  },
  { key: "time", label: "Time", kind: "time", help: "When the daily digest is made, in the server's local time." },
  { key: "weekdaysOnly", label: "Weekdays only", kind: "boolean" },
  { key: "skill", label: "Digest skill", kind: "skill", builtin: BUILTIN_DIGEST_SKILL_NAME },
  { key: "budgetUsd", label: "Agent budget", kind: "number", min: 0.1, max: 100, step: 0.1, unit: "USD" },
  { key: "timeoutMinutes", label: "Agent timeout", kind: "number", min: 1, max: 1440, unit: "minutes" },
  {
    key: "model",
    label: "Agent model",
    kind: "text",
    placeholder: "The light tier's model",
    help: "As claude --model takes it, e.g. haiku. Blank uses the light tier when it maps to a Claude model.",
  },
];
