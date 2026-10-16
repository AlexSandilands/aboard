import { BRAND } from "./brand.ts";
import { REVIEW_DONE_NEXT, type ReviewSkillRef } from "./reviews.ts";
import type { TaskSummary } from "./schemas.ts";

/**
 * Body of the board's built-in review skill. `skills/aboard-review/SKILL.md` ships the same text with
 * frontmatter (a test keeps them identical); it lives here so the bundled server can hand it to agents
 * without reading files from the repo.
 */
export const BUILTIN_REVIEW_SKILL_BODY = `# Local review

You are an independent reviewer. You did not write this change, and you have fresh context: use it. Your
job is to find what would make a careful maintainer send the change back, before a pull request exists.

## What to read

1. The task: description, plan, plan context and step notes say what the change is meant to do.
2. The diff of the current branch against where it forked, plus uncommitted work: find the fork point with
   \`git merge-base HEAD origin/HEAD\` (fall back to \`origin/main\` or \`main\`), then run \`git diff <that commit>\`
   and \`git status\`. Run them as separate commands; \`$(...)\` substitutions may need a permission you don't have.
3. Enough of the surrounding code to judge the change: callers, tests, and the project's own conventions
   (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, linters' configs).

## What to look for, most important first

- **Correctness:** wrong behaviour, unhandled edge cases (empty, null, concurrent, error paths), broken
  invariants, off-by-one, races, state that can go stale.
- **Security and data:** injection, unchecked input at a trust boundary, secrets in code or logs, data loss,
  migrations that can't run on existing data.
- **Does it do the task?** Requirements from the description or plan that are missing or half done.
- **Tests:** changed behaviour with no test, tests that can't fail, tests that test the mock.
- **Fit:** duplicated helpers the codebase already has, code that ignores the project's conventions,
  needless complexity, misleading names or comments.

Don't report what tools already enforce (formatting, import order) or taste without a reason.

## Severity

- **blocking:** wrong behaviour, data loss, a security hole, or the task isn't done.
- **major:** a likely bug, a risky edge case, or a changed path with no test.
- **minor:** maintainability: duplication, unclear code, a weak test.
- **nit:** small polish. Use sparingly.

Blocking and major findings send the change back for another round; minor and nit may stay open.

## Earlier rounds

The task lists earlier findings and how they were resolved. Findings still open stay open on their own: don't
raise them again, just mention in your summary that they are unresolved. Check every finding marked fixed: if
the fix doesn't hold, raise it again as a new finding. Accept a reasoned "won't fix" unless the reason is wrong.
Your findings are only what's new: problems nobody has raised yet, and fixes that didn't work.

## Each finding

One problem per finding: a short title, the file and line, what goes wrong and when, and a concrete
suggestion. Be specific enough that someone can act on it without asking you.
`;

type TaskRef = Pick<TaskSummary, "number" | "title">;

export interface ReviewPromptInput {
  task: TaskRef;
  /** The round the reviewer submits to (numbered across the task's whole history). */
  round: number;
  /** Which round of the current cycle it is; the limit applies per cycle. */
  cycleRound: number;
  maxRounds: number;
  skill: ReviewSkillRef;
}

const skillLines = (skill: ReviewSkillRef): string[] =>
  skill.source === "builtin"
    ? ["How to review:", "", BUILTIN_REVIEW_SKILL_BODY.trim()]
    : [`How to review: read the skill "${skill.name}" at ${skill.path} and follow it.`];

/** What the reviewer subagent (or the board's headless reviewer) is given. Read-only: it records, never edits. */
export function reviewerBrief({ task, round, skill }: Pick<ReviewPromptInput, "task" | "round" | "skill">): string {
  const ref = `"#${task.number}"`;
  return [
    `Review task #${task.number} "${task.title}" from the ${BRAND.id} task board. This is review round ${round}.`,
    "",
    `- Call get_task(${ref}) on the ${BRAND.id} MCP server for what the change should do and for earlier rounds' findings and resolutions.`,
    "- Review the changes on the current branch, including uncommitted work. Don't edit any files.",
    `- Record your result with submit_review(task: ${ref}, round: ${round}, summary, headSha: output of \`git rev-parse HEAD\`, findings: [{severity, title, file, line, body, suggestion}]). Submit an empty findings list if the change is clean.`,
    "- Then reply with one short paragraph: the number of findings by severity.",
    "",
    ...skillLines(skill),
  ].join("\n");
}

/**
 * Sent when a round came back with blocking or major findings but no agent is looping on it (the board's own
 * reviewer ran it): fix, resolve, then carry on with the loop.
 */
export function reviewFixInstructions({
  task,
  round,
  cycleRound,
  maxRounds,
}: Omit<ReviewPromptInput, "skill">): string {
  const ref = `"#${task.number}"`;
  return [
    `Review round ${round} of task #${task.number} "${task.title}" found blocking or major issues. Before you open a pull request:`,
    `1. Call get_task(${ref}) on the ${BRAND.id} MCP server and read the open findings.`,
    "2. Fix every open blocking and major finding (minor and nit too when cheap), then mark each with resolve_finding (status fixed, or wont_fix with a note saying why).",
    cycleRound < maxRounds
      ? `3. Call start_review(${ref}) and follow what it returns: it runs the next round with a fresh reviewer, up to ${maxRounds} rounds.`
      : "3. That was the last review round: don't start another. Leave anything you can't fix open.",
    `4. ${REVIEW_DONE_NEXT}`,
  ].join("\n");
}

/**
 * Told to the implementing agent when its move to Review opened a round (and by start_review): run the loop
 * with a fresh reviewer subagent per round until nothing blocking or major is open, then open the PR.
 */
export function reviewLoopInstructions(input: ReviewPromptInput): string {
  const { task, round, cycleRound, maxRounds } = input;
  const ref = `"#${task.number}"`;
  const which = round === cycleRound ? `round ${round}` : `round ${round} (${cycleRound} of this review)`;
  return [
    `Local review is on for this task: ${which} is open, up to ${maxRounds} rounds. Run the review loop before you open a pull request:`,
    "1. Start a reviewer subagent with fresh context (Claude Code: the Agent tool; Copilot: a subagent) and give it the brief below. Wait for it to finish; it records its findings on the board.",
    `2. Call get_task(${ref}). Fix every open blocking and major finding (minor and nit too when cheap), then mark each with resolve_finding (status fixed, or wont_fix with a note saying why).`,
    `3. If the round raised blocking or major findings, call start_review(${ref}) and repeat from step 1 with a new reviewer. Stop when a round comes back clean or after ${maxRounds} rounds.`,
    `4. ${REVIEW_DONE_NEXT}`,
    'If you can\'t start subagents, do the review yourself as a separate pass that follows the brief, and submit_review with actor "self-review".',
    "",
    "Reviewer brief:",
    "---",
    reviewerBrief(input),
    "---",
  ].join("\n");
}
