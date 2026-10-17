import { z } from "zod";

// The settings "Ask" (docs/features/board-layout.md#settings-page): a question in plain words, answered by a small
// model that is shown the settings index. The web app owns the index (it is built from the page's own nav), so the
// request carries the entries and the server checks the model's pick against them.

/** Longest question the box sends; a sentence, not an essay. */
export const SETTINGS_ASK_QUESTION_MAX = 300;
/** Most entries one request may carry (the index has about a hundred). */
export const SETTINGS_ASK_ENTRIES_MAX = 400;

export const SettingsAskEntry = z.object({
  /** The settings target: what the page opens, and the element id on it. */
  id: z.string().min(1).max(200),
  title: z.string().max(200),
  description: z.string().max(1000),
  /** "Group › Sub-section", as the results show it. */
  location: z.string().max(200),
  keywords: z.array(z.string().max(100)).max(30),
});
export type SettingsAskEntry = z.infer<typeof SettingsAskEntry>;

export const AskSettingsInput = z.object({
  question: z.string().trim().min(1).max(SETTINGS_ASK_QUESTION_MAX),
  entries: z.array(SettingsAskEntry).min(1).max(SETTINGS_ASK_ENTRIES_MAX),
});
export type AskSettingsInput = z.infer<typeof AskSettingsInput>;

/** An answer, with the setting to jump to (null when none fits), or why none could be had. */
export const AskSettingsResult = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    answer: z.string(),
    /** An id from the request's entries, or null. */
    settingId: z.string().nullable(),
    costUsd: z.number().nullable(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type AskSettingsResult = z.infer<typeof AskSettingsResult>;

/** Whether the Ask can run now: the Claude Code CLI is found. */
export const SettingsAskStatus = z.object({ available: z.boolean(), reason: z.string().nullable() });
export type SettingsAskStatus = z.infer<typeof SettingsAskStatus>;
