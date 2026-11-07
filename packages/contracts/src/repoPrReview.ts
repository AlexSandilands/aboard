import { z } from "zod";
import { PR_REVIEW_OUTPUT_SCHEMA, PrReviewVerdict } from "./prReview.ts";

// Review PRs' second source, other people's PRs (docs/features/autopilot.md#other-peoples-prs): open pull requests by
// the authors the user lists, that no task links to. A read-only agent returns a decision; the server checks the
// approval gate, then approves, requests changes or hands the PR to the user. Nothing here is fixed by Fix PRs.

/** What a review of another person's PR is about, worked out from the PR's history on the git host. */
export const RepoPrMode = z.enum([
  /** A first review, or a new head after changes were requested. */
  "full",
  /** An approval (Autopilot's, or the user's own that a push dismissed) of an older head; new commits came since. */
  "delta",
  /** Handed to the user at an older head; the author has pushed real changes since. */
  "followup",
  /** The author replied on one of Autopilot's open threads without pushing. */
  "dispute",
  /** The round limit is used up. */
  "cap_reached",
]);
export type RepoPrMode = z.infer<typeof RepoPrMode>;

/**
 * Why a PR goes to the user. The agent gives the first five; `cap` and `gate` are the server's. `gate` is the lighter
 * path: the review is clean and only the approval gate (or the Approve switch) stops an approval.
 */
export const EscalationReason = z.enum(["departure", "dependency", "security", "dispute", "vague", "cap", "gate"]);
export type EscalationReason = z.infer<typeof EscalationReason>;

/** The reasons an agent may give; the server adds `cap` and `gate`. */
export const AGENT_ESCALATION_REASONS = ["departure", "dependency", "security", "dispute", "vague"] as const;

/** How each reason reads after "Handed to you: ". */
export const ESCALATION_REASON_TEXT: Record<EscalationReason, string> = {
  departure: "a significant departure from the plan or an earlier decision",
  dependency: "a new runtime dependency",
  security: "security-sensitive code",
  dispute: "a disagreement with the author it can't settle",
  vague: "the issue is too vague to judge against",
  cap: "the round limit is used up",
  gate: "ready for your approval",
};

export const RepoPrDecision = z.enum(["approve", "request_changes", "escalate"]);
export type RepoPrDecision = z.infer<typeof RepoPrDecision>;

/** The agent's judgement of the author's reply on one of Autopilot's threads. */
export const DisputeOutcome = z.object({
  /** The id of the thread's first comment (Autopilot's), as `pr_threads` shows it. */
  commentId: z.number().int(),
  /** accepted: the author is right, the thread is resolved; rejected: the point stands; unsure: the user decides. */
  outcome: z.enum(["accepted", "rejected", "unsure"]),
  /** One or two sentences on why, posted as a reply on the thread. */
  reply: z.string().optional(),
});
export type DisputeOutcome = z.infer<typeof DisputeOutcome>;

/** What the reviewer of another person's PR returns. The server posts it; the agent posts nothing. */
export const RepoPrReviewVerdict = PrReviewVerdict.extend({
  decision: RepoPrDecision,
  /** Why the PR goes to the user, with a checklist of exactly what to look at. Required with `escalate`. */
  escalation: z
    .object({
      reason: z.enum(AGENT_ESCALATION_REASONS),
      /** One line. */
      why: z.string(),
      /** What the user should look at: files and lines, the decision to make, the open points, the author's replies. */
      checklist: z.array(z.string()),
    })
    .optional(),
  /** Its judgement of each author reply on one of Autopilot's threads (dispute mode, or replies seen in passing). */
  disputes: z.array(DisputeOutcome).optional(),
  /** False only for a small delta re-approval that answers earlier points or brings in the base branch. */
  counted: z.boolean().optional(),
});
export type RepoPrReviewVerdict = z.infer<typeof RepoPrReviewVerdict>;

/** The same as a JSON schema, for `claude -p --json-schema`: the PR review's, plus the decision. */
export const REPO_PR_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ...PR_REVIEW_OUTPUT_SCHEMA.properties,
    decision: {
      type: "string",
      enum: RepoPrDecision.options,
      description:
        "approve: nothing blocking or major is open and the change follows its issue; request_changes: blocking or major points the author should fix; escalate: the user must judge (see escalation).",
    },
    escalation: {
      type: "object",
      description: "Required when decision is escalate.",
      properties: {
        reason: { type: "string", enum: [...AGENT_ESCALATION_REASONS] },
        why: { type: "string", description: "One line: what the user must decide." },
        checklist: {
          type: "array",
          items: { type: "string" },
          description:
            "Exactly what to look at: files and line ranges, the decision, open points, the author's replies.",
        },
      },
      required: ["reason", "why", "checklist"],
    },
    disputes: {
      type: "array",
      description: "Your judgement of each author reply on one of Autopilot's open threads. Empty when there are none.",
      items: {
        type: "object",
        properties: {
          commentId: { type: "integer", description: "The thread's first comment id, as pr_threads shows it." },
          outcome: { type: "string", enum: DisputeOutcome.shape.outcome.options },
          reply: { type: "string", description: "One or two sentences on why, posted on the thread." },
        },
        required: ["commentId", "outcome"],
      },
    },
    counted: {
      type: "boolean",
      description:
        "False only for a delta re-approval whose change since the approved commit is small and only answers earlier points or brings in the base branch. Otherwise true.",
    },
  },
  required: [...PR_REVIEW_OUTPUT_SCHEMA.required, "decision"],
} as const;

/** What happened on the PR, as the run's output and the PR's stored state say it. */
export const RepoPrOutcome = z.enum(["approved", "changes_requested", "escalated", "ready"]);
export type RepoPrOutcome = z.infer<typeof RepoPrOutcome>;

/** What a review of another person's PR leaves on its run (`run.output`). */
export const RepoPrReviewRunOutput = z.object({
  kind: z.literal("repo_pr_review"),
  host: z.string(),
  repo: z.string(),
  number: z.number().int(),
  prUrl: z.string(),
  headOid: z.string(),
  mode: RepoPrMode,
  round: z.number().int().positive(),
  maxRounds: z.number().int().positive(),
  counted: z.boolean(),
  outcome: RepoPrOutcome,
  reason: EscalationReason.nullable(),
  /** The review, or the hand-off comment, on the git host. */
  url: z.string().nullable(),
  counts: z.object({ blocking: z.number(), major: z.number(), minor: z.number(), nit: z.number() }),
  fyi: z.number().int(),
  resolvedThreads: z.number().int().optional(),
  /** The manual task a real escalation made or noted. */
  taskId: z.string().nullable().optional(),
});
export type RepoPrReviewRunOutput = z.infer<typeof RepoPrReviewRunOutput>;

// ── Settings ─────────────────────────────────────────────────────────────

/** The sensitive paths a new board starts with: CI and tooling, code owners and lockfiles. */
export const DEFAULT_SENSITIVE_PATHS =
  ".github/, tools/, CODEOWNERS, *.lock, package-lock.json, pnpm-lock.yaml, go.sum";

/** Logins from a comma or whitespace separated list, lower-cased, without a leading `@`, each once. */
export function parseLogins(text: unknown): string[] {
  if (typeof text !== "string") return [];
  const logins = text
    .split(/[\s,]+/)
    .map((s) => s.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
  return [...new Set(logins)];
}

/** Path patterns from a comma or newline separated list. */
export function parsePathPatterns(text: unknown): string[] {
  if (typeof text !== "string") return [];
  return text
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const globToRegex = (glob: string): RegExp => {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (glob[i + 1] === "/") i += 1;
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
};

/**
 * Whether a changed file matches one of the patterns. `dir/` matches everything under that folder at the repository's
 * root; a pattern with no `/` matches the file's name in any folder (`*.lock`, `CODEOWNERS`); any other pattern matches
 * the whole path (`docs/*.md`). `*` stops at a `/`, `**` doesn't, `?` is one character.
 */
export function matchesPathPattern(path: string, pattern: string): boolean {
  const p = pattern.replace(/^\.?\//, "");
  if (p.endsWith("/")) return path.startsWith(p);
  if (!p.includes("/")) return globToRegex(p).test(path.slice(path.lastIndexOf("/") + 1));
  return globToRegex(p).test(path);
}

/** The changed files that match any pattern, sorted. */
export function sensitiveFiles(paths: readonly string[], patterns: readonly string[]): string[] {
  return paths.filter((path) => patterns.some((p) => matchesPathPattern(path, p))).sort();
}

// ── Markers ──────────────────────────────────────────────────────────────

/**
 * The hidden marker at the end of everything Autopilot posts on another person's PR. It is the one the custom
 * "Autopilot PR review" automation wrote, so switching to this keeps a PR's history: rounds, approvals and hand-offs
 * are read back from the host, the same way for old and new posts.
 *   review:   `<!-- autopilot-review head=<sha> verdict=approve|changes counted=1|0 round=<n> -->`
 *   hand-off: `<!-- autopilot-review event=escalated head=<sha> reason=<reason> round=<n> counted=1 -->`
 *   inline:   `<!-- autopilot-review finding -->`
 * Older posts have no `round`, and older hand-offs no `counted` or (the first version's) no `reason`.
 */
export const REVIEW_MARKER = "<!-- autopilot-review";

/** The marker's `key=value` pairs, or null for a body without it. A bare word (`finding`) is a key with value "". */
export function parseReviewMarker(body: string | null | undefined): Record<string, string> | null {
  const text = body ?? "";
  const i = text.indexOf(REVIEW_MARKER);
  if (i < 0) return null;
  const end = text.indexOf("-->", i);
  const inner = text.slice(i + REVIEW_MARKER.length, end < 0 ? undefined : end);
  const attrs: Record<string, string> = {};
  for (const word of inner.split(/\s+/).filter(Boolean)) {
    const eq = word.indexOf("=");
    if (eq < 0) attrs[word] = "";
    else attrs[word.slice(0, eq)] = word.slice(eq + 1);
  }
  return attrs;
}

/** The marker line for `attrs`, in the order given. */
export function reviewMarker(attrs: Record<string, string | number>): string {
  const pairs = Object.entries(attrs).map(([k, v]) => (v === "" ? k : `${k}=${v}`));
  return `${REVIEW_MARKER} ${pairs.join(" ")} -->`;
}

/** The control comment the user posts on a PR: `/autopilot stop` or `/autopilot resume`, at the start, any case. */
export function parseControlCommand(body: string): "stop" | "resume" | null {
  const match = /^\s*\/autopilot\s+(resume|stop)\b/i.exec(body);
  return match ? (match[1]!.toLowerCase() as "stop" | "resume") : null;
}

/** The dedupe key of one review of another person's PR: per head commit, resume and author reply. */
export const repoPrDedupeKey = (
  pr: { host: string; repo: string; number: number },
  headOid: string,
  resumeId: number,
  replyId: number,
): string =>
  `review:repo:${pr.host}/${pr.repo}#${pr.number}:${headOid.slice(0, 12)}:r${resumeId}${replyId ? `:c${replyId}` : ""}`;

/** Whether a dedupe key is a review of another person's PR. */
export const isRepoPrReviewKey = (dedupeKey: string): boolean => dedupeKey.startsWith("review:repo:");
