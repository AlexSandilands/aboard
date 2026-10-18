import { z } from "zod";
import {
  SUGGESTION_EVIDENCE_MAX,
  SUGGESTION_RATIONALE_MAX,
  SUGGESTION_TEXT_MAX,
  type EditablePrompt,
  type Suggestion,
} from "@repo/contracts";
import { actorField, run, textResult, type ToolRegistrar } from "../shared.ts";

const targetField = z
  .string()
  .min(1)
  .describe('The key list_editable_prompts gives, e.g. "builtin:review", "automation:<id>" or "skill:<path>".');

const NOT_LISTED = "list_editable_prompts lists the targets you can use.";

/** One line per target: its key, what it is and where it is used. */
const promptLine = (p: EditablePrompt): string => {
  const notes = [
    p.builtin ? "built-in: accepting saves it as the user's own skill" : null,
    p.inRepo ? "a file in a project's repository" : null,
  ].filter(Boolean);
  return `- ${p.key}  ${p.title}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}\n  used by: ${p.usedBy.join(", ")}`;
};

/** One line per earlier suggestion: when, what became of it, and the first line of its rationale. */
const earlierLine = (s: Suggestion): string => {
  const day = (s.resolvedAt ?? s.createdAt).slice(0, 10);
  const why = s.rationale.split("\n")[0]!.trim();
  return `- ${day} ${s.status}: ${why.length > 160 ? `${why.slice(0, 159)}…` : why}`;
};

/** Suggested changes to prompts and skills (docs/features/suggestions.md). Agents propose; only the user applies. */
export const registerSuggestionTools: ToolRegistrar = (server, { services, actor }) => {
  server.registerTool(
    "list_editable_prompts",
    {
      title: "List the prompts and skills you can suggest changes to",
      description:
        "The prompts and skills the user's board runs agents with, which you may suggest changes to: the review and " +
        "planning skills chosen in Settings (the board's built-in ones or SKILL.md files), custom automations' prompts " +
        "and the skills they name. Call it when you have evidence that one of them misleads agents or wastes their time. " +
        "Then read one with get_editable_prompt and propose a rewrite with suggest_change.",
      inputSchema: {},
    },
    () =>
      run(() => {
        const prompts = services.suggestions.editable();
        if (prompts.length === 0) return textResult("Nothing on this board is editable by suggestion yet.");
        return textResult(`Editable prompts (${prompts.length}):\n${prompts.map(promptLine).join("\n")}`);
      }),
  );

  server.registerTool(
    "get_editable_prompt",
    {
      title: "Read a prompt or skill you can suggest a change to",
      description:
        "The full current text of one editable prompt or skill, and its hash. Pass the hash to suggest_change as " +
        "baseHash: the change only applies while the text is still the one you read. It also lists the latest " +
        "suggestions for it and what the user decided: don't propose again what they rejected.",
      inputSchema: { target: targetField },
    },
    (args) =>
      run(
        () => {
          const prompt = services.suggestions.read(args.target);
          const earlier = services.suggestions.forTarget(prompt.key);
          return textResult(
            [
              `${prompt.title}  (target: ${prompt.key})`,
              `hash: ${prompt.hash}`,
              `used by: ${prompt.usedBy.join(", ")}`,
              prompt.path ? `file: ${prompt.path}` : null,
              earlier.length > 0
                ? `earlier suggestions (newest first):\n${earlier.map(earlierLine).join("\n")}`
                : "earlier suggestions: none",
              "",
              "----- current text -----",
              prompt.text,
            ]
              .filter((line) => line !== null)
              .join("\n"),
          );
        },
        { NOT_FOUND: NOT_LISTED },
      ),
  );

  server.registerTool(
    "suggest_change",
    {
      title: "Suggest a change to a prompt or skill",
      description:
        "Propose a rewrite of an editable prompt or skill. Nothing changes until the user reads the diff and accepts " +
        "it in the board's Settings; never ask them to accept it unseen. Read it first with get_editable_prompt and pass " +
        "its hash as baseHash. proposed is the whole new text, not a diff: keep everything that still holds and change " +
        "only what the evidence supports, and prefer removing or tightening text to adding it. rationale says what " +
        'goes wrong today and how the change fixes it; evidence lists what shows it (task refs like "#42", URLs). A ' +
        "newer suggestion for the same target replaces your open one.",
      inputSchema: {
        target: targetField,
        baseHash: z.string().min(1).describe("The hash get_editable_prompt gave for the text you rewrote."),
        proposed: z.string().min(1).max(SUGGESTION_TEXT_MAX).describe("The whole new text."),
        rationale: z
          .string()
          .min(1)
          .max(SUGGESTION_RATIONALE_MAX)
          .describe("Markdown: what goes wrong with the current text and why this change fixes it."),
        evidence: z
          .array(z.string().min(1).max(500))
          .max(SUGGESTION_EVIDENCE_MAX)
          .optional()
          .describe('What shows the problem: task refs ("#42"), PR or other URLs, short notes.'),
        actor: actorField,
      },
    },
    (args) =>
      run(
        () => {
          const { suggestion, replaced } = services.suggestions.suggest(
            {
              target: args.target,
              baseHash: args.baseHash,
              proposed: args.proposed,
              rationale: args.rationale,
              evidence: args.evidence ?? [],
            },
            actor(args.actor),
          );
          return textResult(
            [
              `Suggested a change to ${suggestion.title} (suggestion ${suggestion.id}).`,
              replaced ? `It replaces the open suggestion ${replaced.id} for the same target.` : null,
              "The user reviews it under Settings > Suggestions and accepts or rejects it; nothing has changed yet.",
            ]
              .filter(Boolean)
              .join("\n"),
          );
        },
        {
          CONFLICT: "Call get_editable_prompt again, rework your change on the current text and pass its new hash.",
          NOT_FOUND: NOT_LISTED,
        },
      ),
  );
};
