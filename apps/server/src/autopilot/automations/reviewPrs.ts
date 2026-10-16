import { readFileSync } from "node:fs";
import {
  AUTOPILOT_REVIEW_PRS,
  BRAND,
  BUILTIN_REVIEW_SKILL_BODY,
  type FindingSeverity,
  PR_REVIEW_OUTPUT_SCHEMA,
  PrReviewVerdict,
  ReviewSkillRef,
  actionableCount,
  countReviewIssues,
  describeCounts,
  effectiveFixThreshold,
  isReviewOfLink,
  prReviewDedupeKey,
  prReviewHeader,
  prReviewMarker,
  prReviewOutput,
  type PrReviewHandoff,
  type PrReviewRunOutput,
  type SeverityCounts,
} from "@repo/contracts";
import { z } from "zod";
import { RUNNER_DEFAULTS, RUNNER_OPTION_SHAPE } from "../runnerOptions.ts";
import { defineAutomation, type ActionResult, type Candidate } from "../types.ts";

export { AUTOPILOT_REVIEW_PRS };

/** Tools on top of the reviewer's read-only ones: read the PR, and post the review. */
export const REVIEW_TOOLS = ["Bash(gh pr view *)", "Bash(gh pr diff *)", "Bash(gh pr review *)", "Bash(gh api *)"];

/** An earlier Autopilot review of the same PR, for the prompt of the next round. */
export interface EarlierReview {
  round: number;
  headOid: string;
  reviewUrl: string;
  reviewId: number | null;
  counts: SeverityCounts;
  fyi: number;
}

interface ReviewData {
  linkId: string;
  url: string;
  host: string;
  repo: string;
  number: number;
  title: string;
  headRef: string;
  headOid: string;
  round: number;
  maxRounds: number;
  earlier: EarlierReview[];
}

const shortSha = (sha: string) => sha.slice(0, 7);

/** The skill's text without its frontmatter, or null when the file can't be read. */
function readSkillBody(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
      .trim();
  } catch {
    return null;
  }
}

/** The review skill as the prompt gives it: its text, so the agent needs no file outside the worktree. */
function skillSection(skill: ReviewSkillRef): string[] {
  if (skill.source === "builtin") return [BUILTIN_REVIEW_SKILL_BODY.trim()];
  const body = readSkillBody(skill.path);
  return body ? [body] : [`Read the skill "${skill.name}" at ${skill.path} and follow it.`];
}

export interface ReviewPromptInput {
  task: { number: number; title: string };
  pr: Pick<ReviewData, "url" | "host" | "repo" | "number" | "title" | "headRef" | "headOid">;
  round: number;
  maxRounds: number;
  /** The severity bar for this round, already raised on the last one. */
  threshold: FindingSeverity;
  earlier: readonly EarlierReview[];
  skill: ReviewSkillRef;
}

/** The prompt of one review round. The agent posts the review itself; the board records only its verdict. */
export function reviewPrompt({ task, pr, round, maxRounds, threshold, earlier, skill }: ReviewPromptInput): string {
  const last = round >= maxRounds;
  const host = pr.host.toLowerCase() === "github.com" ? "" : ` --hostname ${pr.host}`;
  const endpoint = `repos/${pr.repo}/pulls/${pr.number}`;
  const lines = [
    `Review pull request #${pr.number} "${pr.title}" (${pr.url}), linked to ${BRAND.name} task #${task.number} "${task.title}". This is review round ${round} of ${maxRounds}, at head commit ${shortSha(pr.headOid)}.`,
    "",
    `You are the reviewer, running unattended as ${BRAND.name} Autopilot. Your working directory is a read-only checkout of the PR's branch \`${pr.headRef}\`: don't edit files, commit or push. Don't call the ${BRAND.id} board's tools: this review is not recorded on the board, only on GitHub.`,
    "",
    "## How to review",
    "",
    "The skill below was written for reviewing a branch before its pull request exists. Here the change is the pull request: read it with `gh pr view` and `gh pr diff` (and `git diff`, `git log`, `git show` in the checkout), and follow the skill for what to look for and how to rate it. Where it says to record findings anywhere other than GitHub, ignore that: you post the review as described below.",
    "",
    ...skillSection(skill),
    "",
  ];

  if (earlier.length > 0) {
    lines.push(
      "## Earlier reviews",
      "",
      `${BRAND.name} Autopilot has already reviewed this pull request:`,
      ...earlier.map(
        (e) =>
          `- Round ${e.round}, at ${shortSha(e.headOid)}: ${e.reviewUrl}${e.reviewId !== null ? ` (review id ${e.reviewId})` : ""}: ${describeCounts(e.counts)}${e.fyi > 0 ? `, ${e.fyi} FYI` : ""}`,
      ),
      "",
      `Read them and the replies to them (\`gh api ${endpoint}/reviews/<id>/comments${host}\`, \`gh pr view ${pr.number} --comments\`). Then:`,
      "- Focus on regressions in the commits since, and on earlier points that are still not fixed.",
      "- Don't raise again a point that was fixed or that the author declined with a reason (unless the reason is wrong).",
      '- Put new minor and nit points in a section of the summary titled "FYI (no action needed)", not in inline comments, and mark them `fyi: true` in your answer.',
      "",
    );
  }

  lines.push(
    "## Severity",
    "",
    `Rate each point blocking, major, minor or nit. Autopilot asks for a fix only for points at or above **${threshold}**${last ? `; this is the last round, so it asks for nothing below ${threshold} and won't review again` : ""}. A point below it is still worth posting, in the FYI section of the summary (\`fyi: true\`).`,
    "",
    "## Post the review",
    "",
    `Post exactly one review, as a comment, with \`gh api\`, so it comes from the user's own \`gh\` login. Send the payload on stdin:`,
    "",
    "```",
    `gh api ${endpoint}/reviews${host} --method POST --input - <<'EOF'`,
    `{"commit_id": "${pr.headOid}", "event": "COMMENT", "body": "<summary>", "comments": [{"path": "<file>", "line": <line>, "side": "RIGHT", "body": "<comment>"}]}`,
    "EOF",
    "```",
    "",
    `- \`event\` is always \`COMMENT\`. Never approve and never request changes (those commands are denied).`,
    `- The summary starts with the line \`${prReviewHeader()}\`, then your verdict and the main risks. Each inline comment starts with \`${prReviewMarker()}\` and its severity, e.g. \`${prReviewMarker()} · major: …\`, and says what goes wrong and what to do about it.`,
    "- Use inline comments (`line` is a line of the file at that commit, on a line the diff touches) for points tied to code, and the summary for the rest. If GitHub rejects the review because an inline comment's line isn't in the diff, move that point into the summary and post again. If it was accepted, don't post a second review.",
    "- Post the review even when you found nothing: the summary then says what you checked and that nothing needs a fix.",
    "- The response has the review's `id` and `html_url`.",
    "",
    "## Your answer",
    "",
    "Finish with the structured answer: the review's URL and id, the commit you reviewed (`git rev-parse HEAD`), your summary, and every point you raised (also the FYI ones) with its severity and whether it is FYI.",
  );
  return lines.join("\n");
}

/**
 * What the review means for the loop. Issues at or above the bar with rounds left go to the fix automation; on the
 * last round they can't be fixed, so Autopilot gives up and says so.
 */
export function reviewHandoff(actionable: number, round: number, maxRounds: number): PrReviewHandoff {
  if (actionable === 0) return "clean";
  return round >= maxRounds ? "gave_up" : "fix";
}

/** Reviews Autopilot finished on the link, oldest first. */
export function earlierReviews(
  runs: ReadonlyArray<Parameters<typeof prReviewOutput>[0]>,
  linkId: string,
): EarlierReview[] {
  return runs
    .flatMap((run) => {
      const out = prReviewOutput(run);
      return out && out.linkId === linkId ? [out] : [];
    })
    .map(({ round, headOid, reviewUrl, reviewId, counts, fyi }) => ({
      round,
      headOid,
      reviewUrl,
      reviewId,
      counts,
      fyi,
    }))
    .sort((a, b) => a.round - b.round);
}

const ConfigSchema = z.object({
  ...RUNNER_OPTION_SHAPE,
  // A review needs the agent held to read-only and given tools, which only a headless run can be.
  runner: z.enum(["auto", "headless"]),
  skill: ReviewSkillRef,
  reviewDrafts: z.boolean(),
});

/**
 * Reviews pull requests linked to tasks and posts the review on GitHub as a comment (docs/features/autopilot.md
 * #review-prs). The agent runs headless in a worktree on the PR's branch, read-only apart from `gh`. The findings
 * stay on GitHub: the board keeps the verdict on the run, and the task gets an activity entry linking the review.
 *
 * One review per PR and head commit (`review:pr:<linkId>:<headOid>`), at most `prReviewRounds` per PR. The verdict
 * decides what comes next: nothing, the fix automation (`handoff: "fix"`), or Autopilot giving up on the last round.
 */
export const reviewPrs = defineAutomation({
  key: AUTOPILOT_REVIEW_PRS,
  title: "Review PRs",
  description:
    "Reviews pull requests linked to tasks and posts the review on GitHub as comments, again when the PR's head commit changes.",
  needsAgent: true,
  schema: ConfigSchema,
  fields: [
    {
      key: "skill",
      label: "Review skill",
      kind: "skill",
      help: "What the reviewer follows. The built-in skill is aboard-review.",
    },
    {
      key: "reviewDrafts",
      label: "Review drafts",
      kind: "boolean",
      help: "Also review pull requests that are still drafts.",
    },
    {
      key: "runner",
      label: "Runner",
      kind: "select",
      help: "A review runs headless: it must be held to read-only.",
      options: [
        { value: "auto", label: "Auto (headless)" },
        { value: "headless", label: "Headless (claude -p in a worktree)" },
      ],
    },
    { key: "budgetUsd", label: "Budget", kind: "number", min: 0.5, max: 100, step: 0.5, unit: "USD" },
    { key: "timeoutMinutes", label: "Timeout", kind: "number", min: 1, max: 1440, unit: "minutes" },
    {
      key: "model",
      label: "Model",
      kind: "text",
      placeholder: "From the task's tier",
      help: "As claude --model takes it, e.g. sonnet. Blank uses the task's tier when it maps to a Claude model.",
    },
  ],
  defaults: {
    ...RUNNER_DEFAULTS,
    runner: "headless",
    budgetUsd: 2,
    timeoutMinutes: 20,
    skill: { source: "builtin" },
    reviewDrafts: false,
  },
  check: ({ services, engine, projects }) =>
    projects.flatMap(({ project, config }): Candidate[] =>
      services.tasks.summaries({ projectId: project.id }).flatMap((task): Candidate[] => {
        if (task.kind === "epic" || task.archivedAt !== null || task.status === "done") return [];
        const links = task.links.flatMap((link) => {
          if (link.kind !== "pr" || !link.ref || !link.snapshot) return [];
          const { state, headOid, headRef } = link.snapshot;
          // Merged and closed PRs are never reviewed; a draft only when asked for.
          if (state === "merged" || state === "closed" || (state === "draft" && !config.reviewDrafts)) return [];
          return headOid && headRef ? [{ link, ref: link.ref, snapshot: link.snapshot, headOid, headRef }] : [];
        });
        if (links.length === 0) return [];
        // The rounds a PR has used are the reviews Autopilot ran on it; a failed one used its round too.
        const runs = services.autopilot
          .runsForTask(task.id, 500)
          .filter((r) => r.automation === AUTOPILOT_REVIEW_PRS && !r.dryRun);
        return links.flatMap(({ link, ref, snapshot, headOid, headRef }): Candidate[] => {
          const dedupeKey = prReviewDedupeKey(link.id, headOid);
          if (runs.some((r) => r.dedupeKey === dedupeKey)) return [];
          const used = runs.filter((r) => isReviewOfLink(r.dedupeKey, link.id));
          if (used.length >= engine.prReviewRounds) return [];
          const round = used.length + 1;
          const data: ReviewData = {
            linkId: link.id,
            url: link.url,
            host: ref.host,
            repo: ref.repo,
            number: ref.number,
            title: snapshot.title,
            headRef,
            headOid,
            round,
            maxRounds: engine.prReviewRounds,
            earlier: earlierReviews(used, link.id),
          };
          return [
            {
              dedupeKey,
              summary: `review PR #${ref.number} at ${shortSha(headOid)} (round ${round} of ${engine.prReviewRounds})`,
              taskId: task.id,
              data,
            },
          ];
        });
      }),
    ),
  act: async (candidate, { services, runner, engine, config, run, actor }): Promise<ActionResult> => {
    const data = candidate.data as ReviewData;
    const task = services.tasks.summary(candidate.taskId!);
    const link = task.links.find((l) => l.id === data.linkId);
    if (link?.kind !== "pr" || !link.snapshot) return { status: "skipped", summary: "The PR link was removed" };
    const { state, headOid } = link.snapshot;
    if (state === "merged" || state === "closed") {
      return { status: "skipped", summary: `PR #${data.number} is ${state}` };
    }
    // The next poll's head commit has its own key, and its own round.
    if (headOid !== data.headOid) {
      return { status: "skipped", summary: `PR #${data.number} moved on to ${shortSha(headOid ?? "")}` };
    }

    const threshold = effectiveFixThreshold(engine.prFixThreshold, data.round, data.maxRounds);
    const result = await runner.start({
      run,
      prompt: reviewPrompt({
        task,
        pr: data,
        round: data.round,
        maxRounds: data.maxRounds,
        threshold,
        earlier: data.earlier,
        skill: config.skill,
      }),
      tier: task.suggestedModel?.tier ?? null,
      options: config,
      access: "read-only",
      tools: REVIEW_TOOLS,
      outputSchema: PR_REVIEW_OUTPUT_SCHEMA,
      workspace: { branch: data.headRef },
    });

    // The review is posted by now, so a verdict that can't be read still fails the run: it is never retried, which
    // keeps one review per head commit.
    const parsed = PrReviewVerdict.safeParse(result.output);
    if (!parsed.success) {
      throw new Error(`The reviewer's answer wasn't a review verdict: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    }
    const verdict = parsed.data;
    const { counts, fyi } = countReviewIssues(verdict.issues);
    const actionable = actionableCount(counts, threshold);
    const handoff = reviewHandoff(actionable, data.round, data.maxRounds);
    const output: PrReviewRunOutput = {
      kind: "pr_review",
      linkId: data.linkId,
      prUrl: data.url,
      // What the agent says it reviewed: the branch may have moved since the poll.
      headOid: verdict.headSha,
      round: data.round,
      maxRounds: data.maxRounds,
      reviewUrl: verdict.reviewUrl,
      reviewId: verdict.reviewId ?? null,
      counts,
      fyi,
      threshold,
      actionable,
      handoff,
    };

    services.tasks.addNote(
      task.id,
      `Autopilot reviewed PR #${data.number} at \`${shortSha(output.headOid)}\` (round ${data.round} of ${data.maxRounds}): [review on GitHub](${verdict.reviewUrl})`,
      actor,
    );

    const found = `${describeCounts(counts)}${fyi > 0 ? `, ${fyi} FYI` : ""}`;
    const head = `Reviewed PR #${data.number} at ${shortSha(output.headOid)} (round ${data.round} of ${data.maxRounds}): ${found}`;
    switch (handoff) {
      case "clean":
        return { summary: `${head}; nothing at or above ${threshold}`, output };
      case "fix":
        return { summary: `${head}; ${actionable} at or above ${threshold} to fix`, output };
      case "gave_up":
        return {
          summary: `Autopilot gave up on PR #${data.number} after ${data.maxRounds} review rounds: ${actionable} at or above ${threshold} still open (${found})`,
          output,
          needsAttention: true,
        };
    }
  },
});
