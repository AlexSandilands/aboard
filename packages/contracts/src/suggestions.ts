import { z } from "zod";

// Suggested changes (docs/features/suggestions.md): an agent proposes a rewrite of a prompt or skill the user can edit,
// and the user accepts or rejects it. Nothing is written without the user.

/**
 * What a suggestion can change, as a key agents pass around: `skill:<absolute SKILL.md path>` for a skill on disk,
 * `builtin:review` / `builtin:plan` for the board's own skills (read-only: accepting forks them), and
 * `automation:<id>` for a custom automation's agent prompt.
 */
export const EditableTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("skill"), path: z.string().min(1) }),
  z.object({ kind: z.literal("builtin"), skill: z.enum(["review", "plan"]) }),
  z.object({ kind: z.literal("automation"), automationId: z.string().min(1) }),
]);
export type EditableTarget = z.infer<typeof EditableTarget>;

export function editableTargetKey(target: EditableTarget): string {
  switch (target.kind) {
    case "skill":
      return `skill:${target.path}`;
    case "builtin":
      return `builtin:${target.skill}`;
    case "automation":
      return `automation:${target.automationId}`;
  }
}

/** The target a key names, or null for one that isn't a key. */
export function parseEditableTargetKey(key: string): EditableTarget | null {
  const colon = key.indexOf(":");
  if (colon < 0) return null;
  const kind = key.slice(0, colon);
  const rest = key.slice(colon + 1);
  const parsed = EditableTarget.safeParse(
    kind === "skill"
      ? { kind, path: rest }
      : kind === "builtin"
        ? { kind, skill: rest }
        : kind === "automation"
          ? { kind, automationId: rest }
          : null,
  );
  return parsed.success ? parsed.data : null;
}

/** Something an agent may propose a change to, as list_editable_prompts lists it. */
export const EditablePrompt = z.object({
  key: z.string(),
  target: EditableTarget,
  /** "Skill review-loop", "Built-in review skill", "Prompt of custom automation Triage". */
  title: z.string(),
  /** Where it is used: "Review skill (board)", "Plan skill of project Alpha", "Custom automation Triage". */
  usedBy: z.array(z.string()),
  /** The SKILL.md for a skill on disk. */
  path: z.string().nullable(),
  /** A skill in a project's folder: accepting changes a file in that repository, which the user commits. */
  inRepo: z.boolean(),
  /** The board's own skill: accepting saves the change as the user's own global skill and switches to it. */
  builtin: z.boolean(),
});
export type EditablePrompt = z.infer<typeof EditablePrompt>;

/** An editable prompt with its current text, and the hash a suggestion passes back as `baseHash`. */
export const EditablePromptText = EditablePrompt.extend({ text: z.string(), hash: z.string() });
export type EditablePromptText = z.infer<typeof EditablePromptText>;

/**
 * open: waiting for the user. accepted / rejected: the user decided. stale: the text changed after the agent read it
 * (or the target went away), so it can't be applied. superseded: a newer suggestion for the same target replaced it.
 */
export const SuggestionStatus = z.enum(["open", "accepted", "rejected", "stale", "superseded"]);
export type SuggestionStatus = z.infer<typeof SuggestionStatus>;

export const SUGGESTION_TEXT_MAX = 100_000;
export const SUGGESTION_RATIONALE_MAX = 4_000;
export const SUGGESTION_EVIDENCE_MAX = 20;

export const Suggestion = z.object({
  id: z.string(),
  targetKey: z.string(),
  target: EditableTarget,
  /** The target's title when the suggestion was made. */
  title: z.string(),
  /** The text the agent read, so the diff still shows after the target changes. */
  baseText: z.string(),
  baseHash: z.string(),
  proposed: z.string(),
  rationale: z.string(),
  /** Task refs ("#12"), URLs or short notes backing the change. */
  evidence: z.array(z.string()),
  status: SuggestionStatus,
  actor: z.string(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  /** What accepting did ("Saved as ~/.claude/skills/…") or why it went stale. */
  outcome: z.string().nullable(),
});
export type Suggestion = z.infer<typeof Suggestion>;

/**
 * A suggestion as Settings lists it. For an open one, `current` says whether the target still holds the text the
 * agent read (`same`), has changed since (`changed`, so accepting would only mark it stale) or is gone (`missing`).
 */
export const SuggestionView = Suggestion.extend({
  current: z.enum(["same", "changed", "missing"]).nullable(),
  inRepo: z.boolean(),
  builtin: z.boolean(),
});
export type SuggestionView = z.infer<typeof SuggestionView>;

/** `GET /api/suggestions`: open ones first, then recent decided ones, with the open count. */
export const SuggestionList = z.object({ items: z.array(SuggestionView), open: z.number().int().min(0) });
export type SuggestionList = z.infer<typeof SuggestionList>;

export const SuggestChangeInput = z.object({
  target: z.string().trim().min(1),
  baseHash: z.string().trim().min(1),
  proposed: z.string().min(1).max(SUGGESTION_TEXT_MAX),
  rationale: z.string().trim().min(1).max(SUGGESTION_RATIONALE_MAX),
  evidence: z
    .array(z.string().trim().min(1).max(500))
    .max(SUGGESTION_EVIDENCE_MAX)
    .default([])
    .transform((items) => [...new Set(items)]),
});
export type SuggestChangeInput = z.input<typeof SuggestChangeInput>;
