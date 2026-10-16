import { z } from "zod";
import { BRAND } from "./brand.ts";
import type { AutopilotRun } from "./autopilot.ts";
import { FINDING_SEVERITIES, FindingSeverity, type SeverityCounts } from "./reviews.ts";

// Autopilot's PR review (docs/features/autopilot.md#review-prs): an agent reviews a linked pull request and posts the
// review on GitHub. The board keeps only the verdict, on the run, and the fix automation reads it from there.

/** The automation's key, stored in settings and runs. */
export const AUTOPILOT_REVIEW_PRS = "review_prs";

/** The first line of the review's summary, and so how a reader tells Autopilot's review from the user's own. */
export const prReviewHeader = (): string => `🤖 ${BRAND.name} Autopilot review`;

/** The short mark at the start of each inline comment. */
export const prReviewMarker = (): string => `🤖 ${BRAND.name} Autopilot`;

/** The dedupe key of the review of one PR link at one head commit. */
export const prReviewDedupeKey = (linkId: string, headOid: string): string => `review:pr:${linkId}:${headOid}`;

/** Whether a run's dedupe key is a review of this link, at any head commit. */
export const isReviewOfLink = (dedupeKey: string, linkId: string): boolean =>
  dedupeKey.startsWith(`review:pr:${linkId}:`);

/** One point the reviewer raised, as the agent reports it. FYI points are posted but never ask for a fix. */
export const PrReviewIssue = z.object({
  severity: FindingSeverity,
  title: z.string(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  fyi: z.boolean(),
});
export type PrReviewIssue = z.infer<typeof PrReviewIssue>;

/** What the review agent returns as its structured answer. */
export const PrReviewVerdict = z.object({
  /** The review on GitHub (`html_url` of the posted review). */
  reviewUrl: z.string().regex(/^https?:\/\//i, "Not a URL"),
  /** GitHub's id of the review, when it reported one. */
  reviewId: z.number().int().optional(),
  /** The commit the agent reviewed (`git rev-parse HEAD`). */
  headSha: z.string().min(1),
  summary: z.string(),
  /** Every point in the review, the FYI ones too. */
  issues: z.array(PrReviewIssue),
});
export type PrReviewVerdict = z.infer<typeof PrReviewVerdict>;

/** The same as a JSON schema, for `claude -p --json-schema`. */
export const PR_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    reviewUrl: { type: "string", description: "html_url of the review you posted." },
    reviewId: { type: "integer", description: "id of the review you posted." },
    headSha: { type: "string", description: "The commit you reviewed: the output of `git rev-parse HEAD`." },
    summary: { type: "string", description: "One paragraph: your overall verdict and the main risks." },
    issues: {
      type: "array",
      description: "Every point in the review, including the FYI ones.",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: FindingSeverity.options },
          title: { type: "string" },
          file: { type: "string", description: "Repo-relative path." },
          line: { type: "integer", minimum: 1 },
          fyi: { type: "boolean", description: "True for a point in the FYI (no action needed) section." },
        },
        required: ["severity", "title", "fyi"],
      },
    },
  },
  required: ["reviewUrl", "headSha", "summary", "issues"],
} as const;

/** What the review means for the loop: nothing to fix, hand over to the fix automation, or out of rounds. */
export const PrReviewHandoff = z.enum(["clean", "fix", "gave_up"]);
export type PrReviewHandoff = z.infer<typeof PrReviewHandoff>;

/**
 * What a finished review leaves on its run (`run.output`): the contract with the fix automation. A run with
 * `handoff: "fix"` is a review whose issues the fix automation should address; `reviewId`s tell it which reviews on
 * the PR are Autopilot's own.
 */
export const PrReviewRunOutput = z.object({
  kind: z.literal("pr_review"),
  linkId: z.string(),
  prUrl: z.string(),
  /** The head commit that was reviewed. */
  headOid: z.string(),
  /** Which review of the PR this was, counting from 1. */
  round: z.number().int().positive(),
  maxRounds: z.number().int().positive(),
  reviewUrl: z.string(),
  reviewId: z.number().int().nullable(),
  /** Non-FYI issues by severity. */
  counts: z.object({
    blocking: z.number().int(),
    major: z.number().int(),
    minor: z.number().int(),
    nit: z.number().int(),
  }),
  /** Issues the reviewer put under FYI. */
  fyi: z.number().int(),
  /** The lowest severity that counted: the engine's fix threshold, raised to at least major on the last round. */
  threshold: FindingSeverity,
  /** Non-FYI issues at or above `threshold`. */
  actionable: z.number().int(),
  handoff: PrReviewHandoff,
});
export type PrReviewRunOutput = z.infer<typeof PrReviewRunOutput>;

/** The review verdict a run left, or null when the run isn't a finished PR review. */
export function prReviewOutput(
  run: Pick<AutopilotRun, "automation" | "status" | "dryRun" | "output">,
): PrReviewRunOutput | null {
  if (run.automation !== AUTOPILOT_REVIEW_PRS || run.status !== "succeeded" || run.dryRun) return null;
  const parsed = PrReviewRunOutput.safeParse(run.output);
  return parsed.success ? parsed.data : null;
}

const RANK: Record<FindingSeverity, number> = { blocking: 0, major: 1, minor: 2, nit: 3 };

/** Whether `severity` is at or above `threshold`. */
export const meetsThreshold = (severity: FindingSeverity, threshold: FindingSeverity): boolean =>
  RANK[severity] <= RANK[threshold];

/**
 * The severity bar for one review round. The last allowed round never asks for more than major issues to be fixed,
 * so a low threshold can't send the loop round again for nits it has no round left to check.
 */
export const effectiveFixThreshold = (threshold: FindingSeverity, round: number, maxRounds: number): FindingSeverity =>
  round >= maxRounds && RANK[threshold] > RANK.major ? "major" : threshold;

/** Non-FYI issues by severity, and how many were FYI. */
export function countReviewIssues(issues: readonly PrReviewIssue[]): { counts: SeverityCounts; fyi: number } {
  const counts: SeverityCounts = { blocking: 0, major: 0, minor: 0, nit: 0 };
  let fyi = 0;
  for (const issue of issues) {
    if (issue.fyi) fyi += 1;
    else counts[issue.severity] += 1;
  }
  return { counts, fyi };
}

/** How many of the counted issues are at or above the threshold. */
export const actionableCount = (counts: SeverityCounts, threshold: FindingSeverity): number =>
  FINDING_SEVERITIES.filter((s) => meetsThreshold(s, threshold)).reduce((sum, s) => sum + counts[s], 0);

/** "1 major, 2 minor": the non-zero counts, most severe first; "no issues" when there are none. */
export function describeCounts(counts: SeverityCounts): string {
  const parts = FINDING_SEVERITIES.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`);
  return parts.length > 0 ? parts.join(", ") : "no issues";
}
