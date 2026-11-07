import type {
  MergeMethod,
  PrOptionalChecks,
  PrReviewCommentInfo,
  PrReviewInfo,
  PrReviewThreadInfo,
  PrSnapshot,
} from "@repo/contracts";
import { PrMergeState, parseAutopilotReply } from "@repo/contracts";
import { z } from "zod";
import type { ReviewThreadDetail } from "./gitHost.ts";

// What GitHub says about a pull request, read with GraphQL and mapped to the board's PrSnapshot: the poll's query and
// the fresh read of a PR's review threads.

// ── Pure mapping ─────────────────────────────────────────────────────────

const RollupItem = z
  .object({
    __typename: z.string().optional(),
    status: z.string().nullish(),
    conclusion: z.string().nullish(),
    state: z.string().nullish(),
    /** Whether the base branch requires this check to merge this PR (`isRequired(pullRequestNumber:)`). */
    isRequired: z.boolean().nullish(),
    /** CheckRun only: the check's name, its run id (newer runs have higher ids) and its workflow's id, or the app's when it has no workflow. */
    name: z.string().nullish(),
    databaseId: z.number().nullish(),
    checkSuite: z
      .object({
        app: z.object({ databaseId: z.number().nullish() }).nullish(),
        workflowRun: z.object({ workflow: z.object({ databaseId: z.number().nullish() }).nullish() }).nullish(),
      })
      .nullish(),
  })
  .loose();

const MergeMethodJson = z.string().transform((m) => m.toLowerCase());

const Author = z.object({ login: z.string() }).nullish();

const ReviewNode = z.object({
  databaseId: z.number().nullish(),
  state: z.string(),
  submittedAt: z.string().nullish(),
  authorAssociation: z.string().nullish(),
  viewerDidAuthor: z.boolean().nullish(),
  author: Author,
});

const ReviewCommentNode = z.object({
  databaseId: z.number().nullish(),
  createdAt: z.string(),
  authorAssociation: z.string().nullish(),
  viewerDidAuthor: z.boolean().nullish(),
  author: Author,
  pullRequestReview: z.object({ databaseId: z.number().nullish() }).nullish(),
});

/** One review thread: the poll reads the first fields (`THREAD_FIELDS`), the fresh thread read all (`THREAD_DETAIL_FIELDS`). */
const ReviewThreadNode = z.object({
  id: z.string().nullish(),
  isResolved: z.boolean(),
  viewerCanResolve: z.boolean().nullish(),
  /** The first comment, which says whose review the thread is. */
  root: z
    .object({
      nodes: z.array(
        z
          .object({
            databaseId: z.number().nullish(),
            pullRequestReview: z.object({ databaseId: z.number().nullish() }).nullish(),
          })
          .nullable(),
      ),
    })
    .nullish(),
  comments: z.object({ nodes: z.array(ReviewCommentNode.nullable()) }),
  /** The newest comment's body, only to match Autopilot's marked reply: it is never put in a prompt. */
  latest: z
    .object({
      nodes: z.array(z.object({ body: z.string().nullish(), viewerDidAuthor: z.boolean().nullish() }).nullable()),
    })
    .nullish(),
});
type ReviewThreadNode = z.infer<typeof ReviewThreadNode>;

/** The fields of one pull request the poll reads (`PR_FIELDS`). */
export const GraphqlPr = z.object({
  number: z.number().optional(),
  title: z.string(),
  state: z.string(),
  isDraft: z.boolean().optional(),
  reviewDecision: z.string().nullish(),
  mergeable: z.string().nullish(),
  mergeStateStatus: z.string().nullish(),
  headRefName: z.string().nullish(),
  baseRefName: z.string().nullish(),
  headRefOid: z.string().nullish(),
  isCrossRepository: z.boolean().nullish(),
  updatedAt: z.string().nullish(),
  autoMergeRequest: z.object({ mergeMethod: MergeMethodJson.nullish() }).nullish(),
  reviews: z.object({ nodes: z.array(ReviewNode.nullable()) }).nullish(),
  reviewThreads: z.object({ nodes: z.array(ReviewThreadNode.nullable()) }).nullish(),
  commits: z
    .object({
      nodes: z.array(
        z
          .object({
            commit: z.object({
              statusCheckRollup: z.object({ contexts: z.object({ nodes: z.array(RollupItem) }) }).nullish(),
            }),
          })
          .nullable(),
      ),
    })
    .nullish(),
});
export type GraphqlPr = z.input<typeof GraphqlPr>;

/** The repository fields read with each batch (`REPO_FIELDS`). */
export const GraphqlRepo = z.object({
  squashMergeAllowed: z.boolean().nullish(),
  mergeCommitAllowed: z.boolean().nullish(),
  rebaseMergeAllowed: z.boolean().nullish(),
  autoMergeAllowed: z.boolean().nullish(),
  viewerPermission: z.string().nullish(),
});
export type GraphqlRepo = z.input<typeof GraphqlRepo>;

const FAILING = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PENDING = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);
/** Permissions that can push to the repo, and so merge. */
const CAN_MERGE = new Set(["ADMIN", "MAINTAIN", "WRITE"]);
/** Authors whose reviews the fix automation acts on: people the repository gave access, not anyone who can comment. */
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const REVIEW_STATES: Record<string, PrReviewInfo["state"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

/** Submitted reviews, oldest first; a pending one is only its author's draft. */
function mapReviews(nodes: ReadonlyArray<z.infer<typeof ReviewNode> | null> | undefined): PrReviewInfo[] {
  return (nodes ?? []).flatMap((node) => {
    const state = node && REVIEW_STATES[node.state.toUpperCase()];
    if (!node || !state) return [];
    return [
      {
        id: node.databaseId ?? null,
        author: node.author?.login ?? null,
        state,
        submittedAt: node.submittedAt ?? null,
        own: node.viewerDidAuthor ?? false,
        trusted: TRUSTED.has(node.authorAssociation?.toUpperCase() ?? ""),
      },
    ];
  });
}

/** The thread's newest comment the poll read (GitHub lists them oldest first). */
const newestComment = (thread: ReviewThreadNode) => thread.comments.nodes.findLast((c) => c !== null) ?? null;

/** What Autopilot's reply as the newest comment of the thread says, or null when someone else spoke last. */
function threadReply(thread: ReviewThreadNode): ReturnType<typeof parseAutopilotReply> {
  const latest = thread.latest?.nodes.at(-1);
  return latest?.viewerDidAuthor === true ? parseAutopilotReply(latest.body ?? "") : null;
}

/**
 * Comments on unresolved threads, oldest first. A resolved thread's feedback has been dealt with, and so has one the
 * signed-in account answered last: Autopilot posts as the user, and its reply said what it fixed or declined, so
 * asking again would only let two review bots ping-pong.
 */
function mapReviewComments(threads: z.infer<typeof GraphqlPr>["reviewThreads"]): PrReviewCommentInfo[] {
  return (threads?.nodes ?? [])
    .flatMap((thread) =>
      thread && !thread.isResolved && newestComment(thread)?.viewerDidAuthor !== true ? thread.comments.nodes : [],
    )
    .flatMap((c): PrReviewCommentInfo[] =>
      c && typeof c.databaseId === "number"
        ? [
            {
              id: c.databaseId,
              author: c.author?.login ?? null,
              createdAt: c.createdAt,
              reviewId: c.pullRequestReview?.databaseId ?? null,
              own: c.viewerDidAuthor ?? false,
              trusted: TRUSTED.has(c.authorAssociation?.toUpperCase() ?? ""),
            },
          ]
        : [],
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id));
}

/** The unresolved threads that have a node id, in GitHub's order, as the poll keeps them. */
export function mapReviewThreads(nodes: ReadonlyArray<ReviewThreadNode | null> | undefined): PrReviewThreadInfo[] {
  return (nodes ?? []).flatMap((thread): PrReviewThreadInfo[] => {
    if (!thread || thread.isResolved || !thread.id) return [];
    const newest = newestComment(thread);
    return [
      {
        id: thread.id,
        canResolve: thread.viewerCanResolve ?? false,
        lastCommentId: newest?.databaseId ?? null,
        ownLast: newest?.viewerDidAuthor === true,
        lastReviewId: newest?.pullRequestReview?.databaseId ?? null,
      },
    ];
  });
}

/** The unresolved threads of the fresh read, with their first comment and what Autopilot's newest reply says. */
export function mapReviewThreadDetails(nodes: ReadonlyArray<ReviewThreadNode | null>): ReviewThreadDetail[] {
  const byId = new Map(nodes.flatMap((t) => (t?.id ? [[t.id, t] as const] : [])));
  return mapReviewThreads(nodes).map((info) => {
    const thread = byId.get(info.id)!;
    const root = thread.root?.nodes[0];
    const reply = threadReply(thread);
    return {
      ...info,
      rootCommentId: root?.databaseId ?? null,
      rootReviewId: root?.pullRequestReview?.databaseId ?? null,
      reply: reply?.kind ?? null,
      fixedIn: reply?.kind === "fixed" ? reply.sha : null,
    };
  });
}

/** One rollup entry's effective state: StatusContext.state, or CheckRun conclusion once completed. */
function rollupItemState(item: z.infer<typeof RollupItem>): string {
  if (item.state) return item.state.toUpperCase();
  const status = item.status?.toUpperCase();
  if (status && status !== "COMPLETED") return status;
  return item.conclusion ? item.conclusion.toUpperCase() : status === "COMPLETED" ? "SUCCESS" : "PENDING";
}

type Rollup = ReadonlyArray<z.infer<typeof RollupItem>> | null | undefined;

/**
 * Each check's newest run only. The rollup lists every run on the head commit, including ones a newer run replaced
 * (a workflow's `cancel-in-progress`, a re-run, a PR edit re-triggering it); GitHub's merge box judges a check by its
 * newest run, so an older cancelled or failed one must not count. A check is its name within its workflow, so a
 * same-named job in another workflow (or a run from another app) stays; runs without a name or id, and status contexts (which the rollup already
 * reduces to the latest), pass through. Newer runs have higher ids. Order is kept.
 */
function latestRuns(rollup: NonNullable<Rollup>): NonNullable<Rollup> {
  // Runs outside a workflow (a third-party app) are told apart by app, as GitHub lists them separately.
  const workflowOrApp = (item: NonNullable<Rollup>[number]): string => {
    const workflow = item.checkSuite?.workflowRun?.workflow?.databaseId;
    return workflow != null ? `w${workflow}` : `a${item.checkSuite?.app?.databaseId ?? ""}`;
  };
  const key = (item: NonNullable<Rollup>[number]): string | null =>
    item.name && item.databaseId != null ? `${workflowOrApp(item)}\u0000${item.name}` : null;
  const newest = new Map<string, number>();
  for (const item of rollup) {
    const k = key(item);
    if (k !== null) newest.set(k, Math.max(newest.get(k) ?? -Infinity, item.databaseId ?? -Infinity));
  }
  return rollup.filter((item) => {
    const k = key(item);
    return k === null || item.databaseId === newest.get(k);
  });
}

/**
 * The checks that decide the verdict: those the base branch requires (GitHub's merge box ignores the rest), or every
 * check when none is required, as without branch protection. `rest` is what's left out of the verdict.
 */
function splitRollup(all: NonNullable<Rollup>): { counted: string[]; rest: string[] } {
  const rollup = latestRuns(all);
  const required = rollup.filter((item) => item.isRequired === true);
  const counted = required.length > 0 ? required : rollup;
  return {
    counted: counted.map(rollupItemState),
    rest: required.length > 0 ? rollup.filter((item) => item.isRequired !== true).map(rollupItemState) : [],
  };
}

export function mapChecks(rollup: Rollup): PrSnapshot["checks"] {
  if (!rollup || rollup.length === 0) return "none";
  const { counted } = splitRollup(rollup);
  if (counted.some((s) => FAILING.has(s))) return "failing";
  if (counted.some((s) => PENDING.has(s))) return "pending";
  return "passing";
}

/** Optional checks still running or failing while others are required; undefined when there are none. */
export function mapOptionalChecks(rollup: Rollup): PrOptionalChecks | undefined {
  if (!rollup || rollup.length === 0) return undefined;
  const { rest } = splitRollup(rollup);
  const pending = rest.filter((s) => PENDING.has(s)).length;
  const failing = rest.filter((s) => FAILING.has(s)).length;
  return pending + failing > 0 ? { pending, failing } : undefined;
}

const asMergeState = (value: string | null | undefined): PrMergeState | undefined => {
  const parsed = PrMergeState.safeParse(value?.toLowerCase());
  return parsed.success ? parsed.data : value ? "unknown" : undefined;
};

const asMergeMethod = (value: string | null | undefined): MergeMethod | null =>
  value === "squash" || value === "merge" || value === "rebase" ? value : null;

/** The merge methods the repository's settings allow, in the order merge, squash, rebase. */
export function allowedMergeMethods(repo: {
  mergeCommitAllowed?: boolean | null;
  squashMergeAllowed?: boolean | null;
  rebaseMergeAllowed?: boolean | null;
}): MergeMethod[] {
  const methods: MergeMethod[] = [];
  if (repo.mergeCommitAllowed) methods.push("merge");
  if (repo.squashMergeAllowed) methods.push("squash");
  if (repo.rebaseMergeAllowed) methods.push("rebase");
  return methods;
}

/** Maps one pull request, and the repo it lives in, to a PrSnapshot. */
export function mapPrSnapshot(input: GraphqlPr, repoInput: GraphqlRepo): PrSnapshot {
  const pr = GraphqlPr.parse(input);
  const repo = GraphqlRepo.parse(repoInput);
  const rawState = pr.state.toUpperCase();
  const state: PrSnapshot["state"] =
    rawState === "MERGED" ? "merged" : rawState === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open";
  const review = pr.reviewDecision?.toUpperCase();
  const reviewDecision: PrSnapshot["reviewDecision"] =
    review === "APPROVED"
      ? "approved"
      : review === "CHANGES_REQUESTED"
        ? "changes_requested"
        : review === "REVIEW_REQUIRED"
          ? "review_required"
          : null;
  const merge = pr.mergeable?.toUpperCase();
  const mergeable: PrSnapshot["mergeable"] =
    merge === "MERGEABLE" ? "mergeable" : merge === "CONFLICTING" ? "conflicting" : "unknown";
  const rollup = pr.commits?.nodes.at(-1)?.commit.statusCheckRollup?.contexts.nodes;
  const mergeMethods = allowedMergeMethods(repo);
  const optionalChecks = mapOptionalChecks(rollup);
  const mergeState = asMergeState(pr.mergeStateStatus);
  const threads = mapReviewThreads(pr.reviewThreads?.nodes);
  return {
    state,
    title: pr.title,
    checks: mapChecks(rollup),
    ...(optionalChecks ? { optionalChecks } : {}),
    ...(mergeState ? { mergeState } : {}),
    reviewDecision,
    mergeable,
    headRef: pr.headRefName || null,
    baseRef: pr.baseRefName || null,
    updatedAt: pr.updatedAt || null,
    autoMerge: pr.autoMergeRequest ? (asMergeMethod(pr.autoMergeRequest.mergeMethod) ?? "merge") : null,
    mergeMethods,
    autoMergeAllowed: repo.autoMergeAllowed ?? false,
    canMerge: CAN_MERGE.has(repo.viewerPermission?.toUpperCase() ?? ""),
    headOid: pr.headRefOid || null,
    isCrossRepository: pr.isCrossRepository ?? false,
    reviews: mapReviews(pr.reviews?.nodes),
    reviewComments: mapReviewComments(pr.reviewThreads),
    reviewThreads: threads,
    unresolvedThreads: (pr.reviewThreads?.nodes ?? []).filter((t) => t && !t.isResolved).length,
  };
}

// ── Queries ──────────────────────────────────────────────────────────────

const REPO_FIELDS = "squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed autoMergeAllowed viewerPermission";
const COMMENT_FIELDS = `comments(last: 5) { nodes {
          databaseId createdAt authorAssociation viewerDidAuthor author { login } pullRequestReview { databaseId }
        } }`;
/**
 * What every poll reads of a PR's threads: the newest 30, with no bodies. Each thread's comments are a connection of
 * their own in GitHub's rate-limit cost, and the poll reads up to 25 PRs every 20 seconds, so it stays this lean.
 */
const THREAD_FIELDS = `reviewThreads(last: 30) { nodes { id isResolved viewerCanResolve
        ${COMMENT_FIELDS}
      } }`;
/**
 * The fresh read before resolving anything: the newest 100 threads (GitHub's most per page), each with its first
 * comment and its newest one's body, only to match Autopilot's marked reply. Never put in a prompt.
 */
const THREAD_DETAIL_FIELDS = `reviewThreads(last: 100) { nodes { id isResolved viewerCanResolve
        root: comments(first: 1) { nodes { databaseId pullRequestReview { databaseId } } }
        ${COMMENT_FIELDS}
        latest: comments(last: 1) { nodes { body viewerDidAuthor } }
      } }`;
const prFields = (
  numberVar: string,
) => `number title state isDraft reviewDecision mergeable mergeStateStatus headRefName baseRefName headRefOid isCrossRepository updatedAt
      autoMergeRequest { mergeMethod }
      reviews(last: 20) { nodes { databaseId state submittedAt authorAssociation viewerDidAuthor author { login } } }
      ${THREAD_FIELDS}
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name databaseId checkSuite { app { databaseId } workflowRun { workflow { databaseId } } } status conclusion isRequired(pullRequestNumber: ${numberVar}) }
        ... on StatusContext { state isRequired(pullRequestNumber: ${numberVar}) }
      } } } } } }`;

/**
 * One document reading many PRs of a repo, each under its own alias (`pr0`, `pr1`, …). Numbers
 * travel as variables, so nothing from a link is written into the query.
 */
export function pollQuery(numbers: readonly number[]): { query: string; variables: Record<string, unknown> } {
  const declarations = ["$owner: String!", "$name: String!", ...numbers.map((_, i) => `$n${i}: Int!`)];
  const fields = numbers.map((_, i) => `    pr${i}: pullRequest(number: $n${i}) { ${prFields(`$n${i}`)} }`).join("\n");
  const variables: Record<string, unknown> = {};
  numbers.forEach((n, i) => (variables[`n${i}`] = n));
  return {
    query: `query PollPullRequests(${declarations.join(", ")}) {\n  repository(owner: $owner, name: $name) {\n    ${REPO_FIELDS}\n${fields}\n  }\n}`,
    variables,
  };
}

/** A PR's unresolved threads and its newest commits, read fresh before resolving any thread. */
export const THREAD_STATE_QUERY = `query PullRequestThreads($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      commits(last: 100) { nodes { commit { oid } } }
      ${THREAD_DETAIL_FIELDS}
    }
  }
}`;
export const ThreadState = z.object({
  repository: z.object({
    pullRequest: z.object({
      headRefOid: z.string(),
      commits: z.object({ nodes: z.array(z.object({ commit: z.object({ oid: z.string() }) }).nullable()) }),
      reviewThreads: z.object({ nodes: z.array(ReviewThreadNode.nullable()) }),
    }),
  }),
});
