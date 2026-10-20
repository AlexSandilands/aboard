import type {
  GithubHostStatus,
  GithubStatus,
  IssueRef,
  IssueSnapshot,
  MergeMethod,
  MergePrInput,
  PrRef,
  PrReviewCommentInfo,
  PrOptionalChecks,
  PrReviewInfo,
  PrReviewThreadInfo,
  PrSnapshot,
  TaskLink,
} from "@repo/contracts";
import { EPIC_BRANCH_PREFIX, PrMergeState, parseAutopilotReply, prReviewHeader } from "@repo/contracts";
import { z } from "zod";
import { AppError } from "../errors.ts";
import type { LinksService, SettingsService, TasksService } from "../services/types.ts";
import { defaultRunGh, GhError, type RunGh } from "./gh.ts";
import {
  createGhTokens,
  createGithubApi,
  GithubApiError,
  isTransientGithubError,
  parseGhAuthStatus,
  type GithubApi,
  type GraphqlError,
} from "./githubApi.ts";
import {
  isOlderThan,
  PANEL_OPEN_TTL_MS,
  PANEL_REFRESH_AGE_MS,
  POLL_TICK_MS,
  prIsDue,
  WARM_INTERVAL_MS,
} from "./prPolling.ts";
import type { FetchFn } from "./t3.ts";
import { mapWithConcurrency, type Logger } from "./util.ts";

export const GH_STATUS_INTERVAL_MS = 10 * 60_000;
/** Requests in flight at once, polite to GitHub's secondary limits. */
const POLL_CONCURRENCY = 4;
/** PRs per aliased query; GitHub caps a query's cost, and a large check list is costly. */
const BATCH_SIZE = 25;

// ── Pure mapping ─────────────────────────────────────────────────────────

const RollupItem = z
  .object({
    __typename: z.string().optional(),
    status: z.string().nullish(),
    conclusion: z.string().nullish(),
    state: z.string().nullish(),
    /** Whether the base branch requires this check to merge this PR (`isRequired(pullRequestNumber:)`). */
    isRequired: z.boolean().nullish(),
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

/** An unresolved thread read fresh, with what the poll leaves out. */
export interface ReviewThreadDetail extends PrReviewThreadInfo {
  /** The thread's first comment and the review it was posted in, to tell Autopilot's own review threads. */
  rootCommentId: number | null;
  rootReviewId: number | null;
  /**
   * The newest comment is Autopilot's (the signed-in account, starting with its mark): a reply saying it was fixed
   * (`fixedIn` is the commit) or declined, or something else of Autopilot's, such as its own review comment. Null when
   * someone else spoke last.
   */
  reply: "fixed" | "declined" | "other" | null;
  fixedIn: string | null;
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
 * The checks that decide the verdict: those the base branch requires (GitHub's merge box ignores the rest), or every
 * check when none is required, as without branch protection. `rest` is what's left out of the verdict.
 */
function splitRollup(rollup: NonNullable<Rollup>): { counted: string[]; rest: string[] } {
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
  const mergeMethods: MergeMethod[] = [];
  if (repo.mergeCommitAllowed) mergeMethods.push("merge");
  if (repo.squashMergeAllowed) mergeMethods.push("squash");
  if (repo.rebaseMergeAllowed) mergeMethods.push("rebase");
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
        ... on CheckRun { status conclusion isRequired(pullRequestNumber: ${numberVar}) }
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

const ACTION_STATE_QUERY = `query PullRequestActionState($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { id headRefOid isMergeQueueEnabled mergeStateStatus }
  }
}`;
const ActionState = z.object({
  repository: z.object({
    pullRequest: z.object({
      id: z.string(),
      headRefOid: z.string(),
      isMergeQueueEnabled: z.boolean().nullish(),
      mergeStateStatus: z.string().nullish(),
    }),
  }),
});

/** A PR's unresolved threads and its newest commits, read fresh before resolving any thread. */
const THREAD_STATE_QUERY = `query PullRequestThreads($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      commits(last: 100) { nodes { commit { oid } } }
      ${THREAD_DETAIL_FIELDS}
    }
  }
}`;
const ThreadState = z.object({
  repository: z.object({
    pullRequest: z.object({
      headRefOid: z.string(),
      commits: z.object({ nodes: z.array(z.object({ commit: z.object({ oid: z.string() }) }).nullable()) }),
      reviewThreads: z.object({ nodes: z.array(ReviewThreadNode.nullable()) }),
    }),
  }),
});
const RESOLVE_THREAD_MUTATION = `mutation ResolveReviewThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`;

/** A PR's review threads as GitHub has them now. */
export interface PrThreadState {
  headOid: string;
  /** The PR's newest 100 commits, in full. */
  commits: string[];
  /** Its unresolved threads. */
  threads: ReviewThreadDetail[];
}

const MERGE_MUTATION = `mutation MergePullRequest($input: MergePullRequestInput!) {
  mergePullRequest(input: $input) { clientMutationId }
}`;
const ENABLE_AUTO_MERGE_MUTATION = `mutation EnableAutoMerge($input: EnablePullRequestAutoMergeInput!) {
  enablePullRequestAutoMerge(input: $input) { clientMutationId }
}`;
const DISABLE_AUTO_MERGE_MUTATION = `mutation DisableAutoMerge($pullRequestId: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}`;

const POST_REVIEW_MUTATION = `mutation PostPullRequestReview($input: AddPullRequestReviewInput!) {
  addPullRequestReview(input: $input) { pullRequestReview { databaseId url } }
}`;
const PostedReviewData = z.object({
  addPullRequestReview: z.object({
    pullRequestReview: z.object({ databaseId: z.number().nullish(), url: z.string() }),
  }),
});

/** The signed-in account's own submitted reviews on a PR, newest last, to tell whether a post that errored landed. */
const VIEWER_REVIEWS_QUERY = `query PullRequestViewerReviews($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(last: 30) { nodes { databaseId url state submittedAt viewerDidAuthor body commit { oid } } }
    }
  }
}`;
const ViewerReviews = z.object({
  repository: z.object({
    pullRequest: z.object({
      reviews: z.object({
        nodes: z.array(
          z
            .object({
              databaseId: z.number().nullish(),
              url: z.string(),
              state: z.string(),
              submittedAt: z.string().nullish(),
              viewerDidAuthor: z.boolean().nullish(),
              body: z.string().nullish(),
              commit: z.object({ oid: z.string() }).nullish(),
            })
            .nullable(),
        ),
      }),
    }),
  }),
});

/** An inline comment on a line of the PR's diff. */
export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

export interface PostReviewInput {
  /** The commit the reviewer read (a prefix will do). The review is refused when the PR's head is another. */
  reviewedSha: string;
  body: string;
  comments: readonly ReviewComment[];
}

export interface PostedReview {
  id: number | null;
  url: string;
  /** The PR's head commit the review was posted against, in full. */
  headOid: string;
  /** Inline comments GitHub refused (a line outside the diff) and that went into the body instead. */
  folded: number;
}

/** How far GitHub's clock may differ from ours when a landed review is told by its time. */
const CLOCK_SKEW_MS = 2 * 60_000;

/** GitHub refuses a review body past 65536 characters. */
const MAX_REVIEW_BODY = 60_000;

const clipBody = (text: string): string =>
  text.length > MAX_REVIEW_BODY ? `${text.slice(0, MAX_REVIEW_BODY)}\n\n_…cut off_` : text;

/** The body, with comments that can't be placed on the diff added under it, cut to what GitHub takes. */
export function foldReviewComments(body: string, comments: readonly ReviewComment[]): string {
  if (comments.length === 0) return clipBody(body);
  const items = comments.map((c) => `**\`${c.path}:${c.line}\`**\n\n${c.body}`);
  return clipBody(`${body}\n\n### Inline comments\n\n${items.join("\n\n")}`);
}

/** The PR's head isn't the commit that was reviewed: it moved while the review ran. Nothing was posted. */
export class StaleReviewError extends AppError {
  constructor(
    readonly head: string,
    reviewed: string,
  ) {
    super("CONFLICT", `The PR's head is ${head.slice(0, 7)}, not the ${reviewed.slice(0, 7)} that was reviewed`);
    this.name = "StaleReviewError";
  }
}

// ── Autopilot's merges and the epic's pull request ───────────────────────

const MERGE_TARGET_QUERY = `query PullRequestMergeTarget($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequest(number: $number) { id state headRefOid baseRefName mergeStateStatus }
  }
}`;
const MergeTarget = z.object({
  repository: z.object({
    defaultBranchRef: z.object({ name: z.string() }).nullish(),
    pullRequest: z.object({
      id: z.string(),
      state: z.string(),
      headRefOid: z.string(),
      baseRefName: z.string(),
      mergeStateStatus: z.string().nullish(),
    }),
  }),
});

const EPIC_PR_QUERY = `query EpicPullRequest($owner: String!, $name: String!, $head: String!) {
  repository(owner: $owner, name: $name) {
    id
    defaultBranchRef { name }
    pullRequests(headRefName: $head, states: [OPEN], first: 10) { nodes { number url baseRefName } }
  }
}`;
const EpicPrData = z.object({
  repository: z.object({
    id: z.string(),
    defaultBranchRef: z.object({ name: z.string() }).nullish(),
    pullRequests: z.object({
      nodes: z.array(z.object({ number: z.number(), url: z.string(), baseRefName: z.string() }).nullable()),
    }),
  }),
});
const CREATE_PR_MUTATION = `mutation CreatePullRequest($input: CreatePullRequestInput!) {
  createPullRequest(input: $input) { pullRequest { number url } }
}`;
const CreatedPr = z.object({
  createPullRequest: z.object({ pullRequest: z.object({ number: z.number(), url: z.string() }) }),
});
const PR_ID_QUERY = `query PullRequestId($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
}`;
const PrId = z.object({ repository: z.object({ pullRequest: z.object({ id: z.string() }) }) });
const UPDATE_PR_BODY_MUTATION = `mutation UpdatePullRequestBody($input: UpdatePullRequestInput!) {
  updatePullRequest(input: $input) { clientMutationId }
}`;

/** Autopilot was about to merge where it never may. Nothing was merged. */
export class MergeTargetError extends AppError {
  constructor(message: string) {
    super("VALIDATION", message);
    this.name = "MergeTargetError";
  }
}

/**
 * The guard on every merge the board makes on its own (docs/decisions/0008-autopilot-engine.md): only into the branch
 * it was asked for. Autopilot's merges (`into: "epic"`, the default) must go into an epic's integration branch and
 * never into the default branch. merge_task_pr, for a task the user flagged for auto-merge, is the one path that
 * merges into the default branch (`into: "default"`), and only there. Checked against what GitHub says just before the
 * merge, so a PR retargeted since the last poll is caught.
 */
export function checkAutopilotMergeTarget(target: {
  base: string;
  expectedBase: string;
  defaultBranch: string | null;
  into?: "epic" | "default";
}): void {
  if (target.defaultBranch === null) {
    throw new MergeTargetError("Can't tell the repository's default branch, so the board won't merge");
  }
  if (target.into === "default") {
    if (target.expectedBase !== target.defaultBranch) {
      throw new MergeTargetError(
        `The PR targets ${target.expectedBase}, not the default branch (${target.defaultBranch}): merge_task_pr only merges into the default branch`,
      );
    }
    if (target.base !== target.expectedBase) {
      throw new MergeTargetError(`The PR now merges into ${target.base}, not ${target.expectedBase}`);
    }
    return;
  }
  if (target.base === target.defaultBranch || target.expectedBase === target.defaultBranch) {
    throw new MergeTargetError(`Autopilot never merges into the default branch (${target.defaultBranch})`);
  }
  if (!target.expectedBase.startsWith(EPIC_BRANCH_PREFIX)) {
    throw new MergeTargetError(`Autopilot only merges into an epic's integration branch, not ${target.expectedBase}`);
  }
  if (target.base !== target.expectedBase) {
    throw new MergeTargetError(`The PR now merges into ${target.base}, not the epic's branch ${target.expectedBase}`);
  }
}

/** What Autopilot merges: a task's PR into its epic's integration branch, at the commit it checked. */
export interface EpicMergeInput {
  /** The epic's integration branch the PR must target. */
  base: string;
  /** The head commit every condition was checked at; the merge is refused if the PR moved past it. */
  headOid: string;
}

/** merge_task_pr's merge of a task's PR into the default branch, at the commit it checked. */
export interface DefaultBranchMergeInput {
  /** The base the board's snapshot shows; it must be the default branch, and still the PR's base on GitHub. */
  base: string;
  /** The head commit every condition was checked at; the merge is refused if the PR moved past it. */
  headOid: string;
  method: MergeMethod;
}

/** The epic's draft PR into the default branch. */
export interface EpicPrInput {
  host: string;
  repo: string;
  /** The epic's integration branch. */
  head: string;
  title: string;
  body: string;
}

/** States in which GitHub merges at once rather than waiting, as `gh pr merge --auto` treats them. */
const IMMEDIATELY_MERGEABLE = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

// ── Issues ───────────────────────────────────────────────────────────────

/** What `gh issue view --json` returns, as far as an import reads it. */
const GhIssue = z.object({
  title: z.string(),
  body: z.string().nullish(),
  state: z.string(),
  labels: z.array(z.object({ name: z.string() })).default([]),
});

export interface IssueDetails {
  title: string;
  body: string;
  labels: string[];
  state: IssueSnapshot["state"];
}

/** Parses `gh issue view --json title,body,labels,state`. Throws when it isn't an issue. */
export function parseGhIssue(stdout: string): IssueDetails {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error("gh returned something that isn't JSON");
  }
  const parsed = GhIssue.safeParse(json);
  if (!parsed.success) throw new Error("gh returned an unexpected issue shape");
  const issue = parsed.data;
  return {
    title: issue.title,
    body: issue.body ?? "",
    labels: issue.labels.map((l) => l.name),
    state: issue.state.toUpperCase() === "CLOSED" ? "closed" : "open",
  };
}

/** Parses the issue URLs `gh api … sub_issues --jq '.[].html_url'` prints, one per line. */
export function parseSubIssueUrls(stdout: string): string[] {
  return [
    ...new Set(
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^https?:\/\//.test(line)),
    ),
  ];
}

// ── Hosts ────────────────────────────────────────────────────────────────

/**
 * Hosts that are GitHub without asking `gh`: github.com, GHE.com data residency, and Enterprise
 * Server instances named for it (`github.example.com`). Any other host is polled only once `gh` is
 * signed in to it, since any URL with `/owner/repo/pull/n` parses as a PR.
 */
export function isGithubHost(host: string, signedIn: readonly GithubHostStatus[] = []): boolean {
  const h = host.toLowerCase();
  if (h === "github.com" || h.endsWith(".ghe.com") || h.split(".").includes("github")) return true;
  return signedIn.some((s) => s.host === h);
}

// ── Poller ───────────────────────────────────────────────────────────────

/** The poller's `debug` line is optional so a logger that only warns still fits. */
type PollLogger = Logger & Partial<Pick<Console, "debug">>;

export interface GithubServices {
  links: Pick<LinksService, "listByKind" | "get" | "setSnapshot">;
  tasks: Pick<TasksService, "summary">;
  settings: Pick<SettingsService, "get">;
}

type PrLink = Extract<TaskLink, { kind: "pr" }>;
type RefPrLink = PrLink & { ref: NonNullable<PrLink["ref"]> };

export interface GithubIntegration {
  status(): GithubStatus;
  /** Re-detects gh and its per-host sign-in. */
  checkStatus(): Promise<GithubStatus>;
  /**
   * Whether an unfinished PR on the host keeps a Review task from Done. github.com always does, as
   * before Enterprise support, so not knowing yet whether gh works can't let one merge finish a task
   * whose other PR is open. Other hosts only while they're polled (GitHub, and gh signed in to it).
   */
  holdsTasks(host: string): boolean;
  /**
   * One poll over the GitHub PR links that are due: hot ones every 20 s, warm every 2 minutes, merged or closed every
   * 30 (`prIsDue`). No-op when polling is off or gh is unusable. `now` is for tests.
   */
  pollAll(now?: number): Promise<void>;
  /**
   * A task's panel is open: reads its PR links now when the last read is older than 15 s, and polls them hot while
   * the panel keeps asking. No-op when polling is off or gh is unusable.
   */
  viewTask(taskId: string): Promise<void>;
  /** Reads a PR link that was just added, so it shows its state now rather than at the next poll. Never throws. */
  pollLink(linkId: string): Promise<void>;
  /** Reads an issue with `gh issue view`. Throws AppError (`gh` missing or not signed in, issue not found). */
  fetchIssue(ref: IssueRef): Promise<IssueDetails>;
  /** The URLs of an issue's sub-issues, in GitHub's order; none for an issue without any. Throws AppError. */
  fetchSubIssues(ref: IssueRef): Promise<string[]>;
  /** Fetches one PR link now. Returns false when the link is not a GitHub PR. Throws AppError on failure. */
  refresh(link: TaskLink): Promise<boolean>;
  /** Merges a Review task's PR, or turns auto-merge on or off, then refreshes it. Throws AppError. */
  merge(link: TaskLink, input: MergePrInput): Promise<void>;
  /**
   * Posts one review on the PR as the signed-in account, always as a comment (never an approval or a request for
   * changes). Throws AppError: `gh` missing or not signed in, the PR's head isn't the commit read, GitHub's refusal.
   */
  postReview(ref: PrRef, input: PostReviewInput): Promise<PostedReview>;
  /** The PR's head commit on GitHub now. Throws AppError. */
  prHead(ref: PrRef): Promise<string>;
  /**
   * Autopilot's merge of a task's PR into its epic's integration branch: a merge commit at `headOid`, once
   * checkAutopilotMergeTarget passes on what GitHub says now. Then refreshes the link, which moves the task to Done.
   * Throws MergeTargetError for a target it may never merge into, AppError for anything else GitHub refuses.
   */
  mergeIntoEpicBranch(link: TaskLink, input: EpicMergeInput): Promise<void>;
  /**
   * merge_task_pr's merge of a task's PR into the default branch, at `headOid`, once checkAutopilotMergeTarget (into
   * "default") passes on what GitHub says now. Then refreshes the link. Throws MergeTargetError for any other base,
   * AppError for anything else GitHub refuses.
   */
  mergeIntoDefaultBranch(link: TaskLink, input: DefaultBranchMergeInput): Promise<void>;
  /** The open PR from the epic's branch into the default branch, opened as a draft when there is none. Never merged. */
  ensureEpicPr(input: EpicPrInput): Promise<{ number: number; url: string; created: boolean }>;
  /** Replaces a PR's description. Throws AppError. */
  setPrBody(ref: PrRef, body: string): Promise<void>;
  /** The PR's unresolved review threads and newest commits, read now. Throws AppError. */
  reviewThreads(ref: PrRef): Promise<PrThreadState>;
  /** Resolves one review thread as the signed-in account. Throws AppError. */
  resolveReviewThread(host: string, threadId: string): Promise<void>;
  start(): void;
  stop(): void;
}

export function createGithubIntegration(deps: {
  services: () => GithubServices;
  runGh?: RunGh;
  fetch?: FetchFn;
  log?: PollLogger;
}): GithubIntegration {
  const runGh = deps.runGh ?? defaultRunGh;
  const log: PollLogger = deps.log ?? console;
  const tokens = createGhTokens({ runGh });
  const api: GithubApi = createGithubApi({ tokens, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  let status: GithubStatus = { available: false, authenticated: false, error: null, hosts: [] };
  let checkedAt = 0;
  let checking: Promise<GithubStatus> | null = null;
  let polling = false;
  const timers: NodeJS.Timeout[] = [];
  /** Last error logged per link (or host), so a persistent failure is logged once. */
  const loggedErrors = new Map<string, string>();
  /** When each task's panel last asked for its PRs, so they're polled hot while it's open. */
  const viewedAt = new Map<string, number>();
  /**
   * When a link, or a host (`host:<name>`), last failed. The poller looks every 20 s, so a PR GitHub can't find or a
   * host that refused (a rate limit) is left alone for the warm interval rather than asked again each tick.
   */
  const failedAt = new Map<string, number>();
  const backedOff = (key: string, now: number): boolean => now - (failedAt.get(key) ?? -Infinity) < WARM_INTERVAL_MS;

  const logOnce = (key: string, label: string, message: string) => {
    if (loggedErrors.get(key) === message) return;
    loggedErrors.set(key, message);
    log.warn(`[github] ${label}: ${message}`);
  };

  const checkStatus = (): Promise<GithubStatus> => {
    checking ??= (async (): Promise<GithubStatus> => {
      try {
        await runGh(["--version"], { timeoutMs: 10_000 });
      } catch (error) {
        const notFound = error instanceof GhError && error.notFound;
        return {
          available: false,
          authenticated: false,
          error: notFound ? "gh CLI not found" : messageOf(error),
          hosts: [],
        };
      }
      let stdout: string;
      try {
        stdout = await runGh(["auth", "status", "--json", "hosts"], { timeoutMs: 15_000 });
      } catch (error) {
        // gh exits non-zero when a login has gone bad, but still prints every host.
        stdout = error instanceof GhError ? error.stdout : "";
      }
      const hosts = parseGhAuthStatus(stdout);
      if (hosts) {
        const authenticated = hosts.some((h) => h.authenticated);
        return {
          available: true,
          authenticated,
          error: authenticated ? null : "gh is not authenticated (run `gh auth login`)",
          hosts,
        };
      }
      // A gh too old for `--json`: fall back to the exit code, which can't say which hosts.
      try {
        await runGh(["auth", "status"], { timeoutMs: 15_000 });
        return { available: true, authenticated: true, error: null, hosts: [] };
      } catch {
        return {
          available: true,
          authenticated: false,
          error: "gh is not authenticated (run `gh auth login`)",
          hosts: [],
        };
      }
    })().then((next) => {
      status = next;
      checkedAt = Date.now();
      checking = null;
      return next;
    });
    return checking;
  };

  const ensureStatus = async (): Promise<GithubStatus> =>
    checkedAt === 0 || Date.now() - checkedAt > GH_STATUS_INTERVAL_MS ? checkStatus() : status;

  const signedInHosts = (current: GithubStatus) => current.hosts.filter((h) => h.authenticated);

  const isGithubPr = (link: TaskLink, current: GithubStatus): link is RefPrLink =>
    link.kind === "pr" && link.ref !== null && isGithubHost(link.ref.host, signedInHosts(current));

  /**
   * Whether `gh` is signed in to the host, so its token may be sent there. A `gh` too old to list
   * hosts only vouches for github.com: an env token such as GH_ENTERPRISE_TOKEN would otherwise go
   * to any host a link names.
   */
  const signedInTo = (host: string, current: GithubStatus): boolean =>
    current.hosts.length === 0
      ? current.authenticated && host === "github.com"
      : signedInHosts(current).some((h) => h.host === host);

  const polls = (host: string, current: GithubStatus): boolean =>
    isGithubHost(host, signedInHosts(current)) && signedInTo(host, current);

  /** Reads one batch of a repo's PRs and stores what came back. Per-PR failures are logged. */
  const pollBatch = async (host: string, repo: string, links: readonly RefPrLink[]): Promise<void> => {
    const services = deps.services();
    const [owner, name] = splitRepo(repo);
    const { query, variables } = pollQuery(links.map((l) => l.ref.number));
    const { data, errors } = await api.graphqlBatch(host, query, { owner, name, ...variables });
    const repository = (data as { repository?: Record<string, unknown> | null } | null)?.repository ?? null;
    links.forEach((link, i) => {
      const pr = repository?.[`pr${i}`];
      const parsed = pr ? GraphqlPr.safeParse(pr) : null;
      const repoParsed = repository ? GraphqlRepo.safeParse(repository) : null;
      if (parsed?.success && repoParsed?.success) {
        services.links.setSnapshot(link.id, mapPrSnapshot(parsed.data, repoParsed.data));
        loggedErrors.delete(link.id);
        failedAt.delete(link.id);
        return;
      }
      failedAt.set(link.id, Date.now());
      const message = errorFor(errors, `pr${i}`) ?? (pr ? "GitHub returned an unexpected PR shape" : "PR not found");
      logOnce(link.id, link.url, message);
    });
  };

  /** Links being read now, so a poll, a panel opening and a new link never fetch one at once and race to store it. */
  const inFlight = new Set<string>();

  /** Reads the links in batches per host and repo, and returns how many queries went out. */
  const pollLinks = async (all: readonly RefPrLink[]): Promise<number> => {
    const links = all.filter((l) => !inFlight.has(l.id));
    for (const link of links) inFlight.add(link.id);
    try {
      return await pollBatches(links);
    } finally {
      for (const link of links) inFlight.delete(link.id);
    }
  };

  const pollBatches = async (links: readonly RefPrLink[]): Promise<number> => {
    const groups = new Map<string, { host: string; repo: string; links: RefPrLink[] }>();
    for (const link of links) {
      const key = `${link.ref.host}
${link.ref.repo.toLowerCase()}`;
      const group = groups.get(key) ?? { host: link.ref.host, repo: link.ref.repo, links: [] };
      group.links.push(link);
      groups.set(key, group);
    }
    const batches = [...groups.values()].flatMap((g) =>
      chunk(g.links, BATCH_SIZE).map((batch) => ({ host: g.host, repo: g.repo, links: batch })),
    );
    /** Hosts that answered with a rate limit or a refused token this poll: skip their other batches. */
    const stoppedHosts = new Set<string>();
    let queries = 0;
    await mapWithConcurrency(batches, POLL_CONCURRENCY, async (batch) => {
      if (stoppedHosts.has(batch.host)) return;
      queries += 1;
      try {
        await pollBatch(batch.host, batch.repo, batch.links);
        loggedErrors.delete(`host:${batch.host}`);
        failedAt.delete(`host:${batch.host}`);
      } catch (error) {
        if (error instanceof GithubApiError && error.kind !== "not_found" && error.kind !== "response") {
          stoppedHosts.add(batch.host);
          failedAt.set(`host:${batch.host}`, Date.now());
          logOnce(`host:${batch.host}`, batch.host, error.message);
          return;
        }
        for (const link of batch.links) {
          failedAt.set(link.id, Date.now());
          logOnce(link.id, link.url, messageOf(error));
        }
      }
    });
    return queries;
  };

  /**
   * The polled GitHub PR links, or null when polling is off or gh is unusable. Links that failed lately and links on a
   * host that refused are left out, so no path (the tick, a panel opening, a new link) asks again within the back-off.
   */
  const pollableLinks = async (now: number): Promise<RefPrLink[] | null> => {
    const services = deps.services();
    if (!services.settings.get().githubPolling) return null;
    const current = await ensureStatus();
    if (!current.authenticated) return null;
    const links = services.links
      .listByKind("pr")
      .filter((l): l is RefPrLink => isGithubPr(l, current) && polls(l.ref.host, current));
    const ids = new Set(links.map((l) => l.id));
    for (const key of failedAt.keys()) {
      if (!backedOff(key, now) || !(key.startsWith("host:") || ids.has(key))) failedAt.delete(key);
    }
    return links.filter((l) => !backedOff(l.id, now) && !backedOff(`host:${l.ref.host}`, now));
  };

  const isViewed = (taskId: string, now: number): boolean =>
    now - (viewedAt.get(taskId) ?? -Infinity) < PANEL_OPEN_TTL_MS;

  const pollAll = async (now = Date.now()): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      for (const [taskId] of viewedAt) if (!isViewed(taskId, now)) viewedAt.delete(taskId);
      const links = await pollableLinks(now);
      if (!links) return;
      const due = links.filter((l) => prIsDue(l, now, isViewed(l.taskId, now)));
      if (due.length === 0) return;
      const queries = await pollLinks(due);
      log.debug?.(`[github] polled ${due.length} of ${links.length} PRs in ${queries} queries`);
    } catch (error) {
      log.warn(`[github] poll failed: ${messageOf(error)}`);
    } finally {
      polling = false;
    }
  };

  const pollLink = async (linkId: string): Promise<void> => {
    try {
      const link = (await pollableLinks(Date.now()))?.find((l) => l.id === linkId);
      if (link) await pollLinks([link]);
    } catch (error) {
      log.warn(`[github] couldn't read the new PR link: ${messageOf(error)}`);
    }
  };

  const viewTask = async (taskId: string): Promise<void> => {
    const now = Date.now();
    viewedAt.set(taskId, now);
    try {
      const links = await pollableLinks(now);
      const stale = links?.filter((l) => l.taskId === taskId && isOlderThan(l, now, PANEL_REFRESH_AGE_MS)) ?? [];
      if (stale.length > 0) await pollLinks(stale);
    } catch (error) {
      log.warn(`[github] panel refresh failed: ${messageOf(error)}`);
    }
  };

  /** Checks gh can be used for the link's host, as an AppError the panel can show. */
  const requireGh = async (link: RefPrLink): Promise<void> => {
    const current = await ensureStatus();
    if (!current.available) throw new AppError("VALIDATION", "GitHub CLI (gh) is not installed");
    if (!signedInTo(link.ref.host, current)) {
      throw new AppError(
        "VALIDATION",
        `GitHub CLI (gh) is not signed in to ${link.ref.host}: run \`gh auth login --hostname ${link.ref.host}\``,
      );
    }
  };

  /** Checks `gh` can be used for the host, as an AppError. */
  const requireSignedIn = async (host: string): Promise<void> => {
    const current = await ensureStatus();
    if (!current.available) throw new AppError("VALIDATION", "GitHub CLI (gh) is not installed");
    if (!isGithubHost(host, signedInHosts(current)) || !signedInTo(host, current)) {
      throw new AppError(
        "VALIDATION",
        `GitHub CLI (gh) is not signed in to ${host}: run \`gh auth login --hostname ${host}\``,
      );
    }
  };

  const refreshOne = async (link: RefPrLink): Promise<void> => {
    const [owner, name] = splitRepo(link.ref.repo);
    const { query, variables } = pollQuery([link.ref.number]);
    const data = await api.graphql(link.ref.host, query, { owner, name, ...variables });
    const repository = (data as { repository?: Record<string, unknown> | null } | null)?.repository;
    const pr = GraphqlPr.safeParse(repository?.pr0);
    const repo = GraphqlRepo.safeParse(repository);
    if (!pr.success || !repo.success) throw new Error("GitHub returned an unexpected PR shape");
    deps.services().links.setSnapshot(link.id, mapPrSnapshot(pr.data, repo.data));
    loggedErrors.delete(link.id);
    // A read that worked ends any back-off, so an open panel polls the PR again.
    failedAt.delete(link.id);
    failedAt.delete(`host:${link.ref.host}`);
  };

  /**
   * The newest submitted review the signed-in account left on the PR at this head with Autopilot's header, submitted
   * since `since` (an older one at the same head isn't the post that failed), or null. It is how a post that GitHub
   * answered with an error is told apart from one that never happened.
   */
  const findPostedReview = async (
    ref: PrRef,
    headOid: string,
    since: number,
  ): Promise<{ id: number | null; url: string; body: string } | null> => {
    const [owner, name] = splitRepo(ref.repo);
    const raw = await api.graphql(ref.host, VIEWER_REVIEWS_QUERY, { owner, name, number: ref.number });
    const parsed = ViewerReviews.safeParse(raw);
    if (!parsed.success) return null;
    const header = prReviewHeader();
    const found = parsed.data.repository.pullRequest.reviews.nodes.findLast(
      (r) =>
        r !== null &&
        r.viewerDidAuthor === true &&
        r.state.toUpperCase() !== "PENDING" &&
        r.commit?.oid.toLowerCase() === headOid.toLowerCase() &&
        (r.body ?? "").startsWith(header) &&
        Date.parse(r.submittedAt ?? "") >= since - CLOCK_SKEW_MS,
    );
    return found ? { id: found.databaseId ?? null, url: found.url, body: found.body ?? "" } : null;
  };

  /** A board-made merge at the checked head, once checkAutopilotMergeTarget passes on what GitHub says now. */
  const mergeChecked = async (
    link: TaskLink,
    input: { into: "epic" | "default"; base: string; headOid: string; method: MergeMethod },
  ): Promise<void> => {
    const notGithub = () => new AppError("VALIDATION", "Only a GitHub pull request can be merged");
    if (link.kind !== "pr" || !link.ref) throw notGithub();
    if (!isGithubPr(link, await ensureStatus())) throw notGithub();
    await requireGh(link);
    const [owner, name] = splitRepo(link.ref.repo);
    const host = link.ref.host;
    try {
      const raw = await api.graphql(host, MERGE_TARGET_QUERY, { owner, name, number: link.ref.number });
      const parsed = MergeTarget.safeParse(raw);
      if (!parsed.success) throw new Error("GitHub returned an unexpected PR shape");
      const { pullRequest: pr, defaultBranchRef } = parsed.data.repository;
      checkAutopilotMergeTarget({
        base: pr.baseRefName,
        expectedBase: input.base,
        defaultBranch: defaultBranchRef?.name ?? null,
        into: input.into,
      });
      if (pr.state.toUpperCase() !== "OPEN") throw new AppError("CONFLICT", `The PR is ${pr.state.toLowerCase()}`);
      if (pr.headRefOid !== input.headOid) {
        throw new AppError("CONFLICT", `The PR moved on to ${pr.headRefOid.slice(0, 7)} since it was checked`);
      }
      // An admin's account may merge past branch rules (a required approval, an out-of-date branch); into the
      // default branch the board only merges what GitHub would let anyone merge.
      const state = pr.mergeStateStatus?.toUpperCase() ?? "UNKNOWN";
      if (input.into === "default" && !IMMEDIATELY_MERGEABLE.has(state)) {
        const unresolved = link.kind === "pr" ? (link.snapshot?.unresolvedThreads ?? 0) : 0;
        throw new AppError(
          "VALIDATION",
          state === "UNKNOWN"
            ? "GitHub is still working out whether the PR can be merged: try again in a minute"
            : state === "BLOCKED" && unresolved > 0
              ? `GitHub says the PR can't be merged yet (${state}): it has ${describeUnresolved(unresolved)}, and the repository may require them resolved, or a branch rule such as a required approval isn't met`
              : `GitHub says the PR can't be merged yet (${state}): a branch rule such as a required approval or an up-to-date branch isn't met`,
        );
      }
      await api.graphql(host, MERGE_MUTATION, {
        input: { pullRequestId: pr.id, mergeMethod: input.method.toUpperCase(), expectedHeadOid: pr.headRefOid },
      });
    } catch (error) {
      // Show the new head, or the PR merged or closed by hand, so the next check doesn't try the old head again.
      await refreshOne(link).catch(() => {});
      if (error instanceof AppError) throw error;
      throw new AppError("VALIDATION", messageOf(error));
    }
    try {
      await refreshOne(link);
    } catch (error) {
      logOnce(link.id, link.url, messageOf(error));
    }
  };

  return {
    status: () => {
      if (checkedAt === 0 && !checking) void checkStatus();
      return status;
    },
    checkStatus,
    holdsTasks: (host) => {
      const h = host.toLowerCase();
      return h === "github.com" || polls(h, status);
    },
    pollAll,
    viewTask,
    pollLink,
    async fetchIssue(ref) {
      const target = ref.host === "github.com" ? ref.repo : `${ref.host}/${ref.repo}`;
      try {
        const stdout = await runGh(
          ["issue", "view", String(ref.number), "--repo", target, "--json", "title,body,labels,state"],
          { timeoutMs: 30_000 },
        );
        return parseGhIssue(stdout);
      } catch (error) {
        if (error instanceof GhError && error.notFound) {
          throw new AppError("VALIDATION", "GitHub CLI (gh) is not installed");
        }
        throw new AppError("VALIDATION", `Could not read ${ref.repo}#${ref.number}: ${messageOf(error)}`);
      }
    },
    async fetchSubIssues(ref) {
      try {
        const stdout = await runGh(
          [
            "api",
            ...(ref.host === "github.com" ? [] : ["--hostname", ref.host]),
            "--paginate",
            `repos/${ref.repo}/issues/${ref.number}/sub_issues?per_page=100`,
            "--jq",
            ".[].html_url",
          ],
          { timeoutMs: 30_000 },
        );
        return parseSubIssueUrls(stdout);
      } catch (error) {
        throw new AppError(
          "VALIDATION",
          `Could not read the sub-issues of ${ref.repo}#${ref.number}: ${messageOf(error)}`,
        );
      }
    },
    async refresh(link) {
      // Checked before ensureStatus so refreshing a T3 thread or Jira link never spawns gh.
      if (link.kind !== "pr" || link.ref === null) return false;
      if (!isGithubPr(link, await ensureStatus())) return false;
      await requireGh(link);
      try {
        await refreshOne(link);
      } catch (error) {
        throw new AppError("VALIDATION", `Could not fetch PR: ${messageOf(error)}`);
      }
      return true;
    },
    async merge(link, input) {
      const notGithub = () => new AppError("VALIDATION", "Only GitHub pull requests can be merged from here");
      // Everything that needs no gh comes first, so a refusal never spawns it.
      if (link.kind !== "pr" || !link.ref) throw notGithub();
      const task = deps.services().tasks.summary(link.taskId);
      if (task.status !== "review") throw new AppError("VALIDATION", "Only a task in Review can merge its PR");
      const snapshot = link.snapshot;
      if (!snapshot) throw new AppError("VALIDATION", "Refresh the PR before merging it");
      if (!snapshot.canMerge) throw new AppError("VALIDATION", "The signed-in GitHub account can't merge this PR");
      if (input.action !== "disable_auto" && !snapshot.mergeMethods?.includes(input.method!)) {
        throw new AppError("VALIDATION", `This repository doesn't allow ${input.method} merges`);
      }
      if (!isGithubPr(link, await ensureStatus())) throw notGithub();
      await requireGh(link);

      const [owner, name] = splitRepo(link.ref.repo);
      const host = link.ref.host;
      try {
        // Read fresh rather than from the snapshot: the merge queue decides which mutation a merge is.
        const raw = await api.graphql(host, ACTION_STATE_QUERY, { owner, name, number: link.ref.number });
        const parsed = ActionState.safeParse(raw);
        if (!parsed.success) throw new Error("GitHub returned an unexpected PR shape");
        const state = parsed.data.repository.pullRequest;
        if (input.action === "disable_auto") {
          await api.graphql(host, DISABLE_AUTO_MERGE_MUTATION, { pullRequestId: state.id });
        } else {
          if (snapshot.headOid && snapshot.headOid !== state.headRefOid) {
            throw new AppError(
              "CONFLICT",
              "The PR has new commits since it was last checked. Review them, then merge.",
            );
          }
          const auto =
            state.isMergeQueueEnabled === true ||
            (input.action === "auto" && !IMMEDIATELY_MERGEABLE.has(state.mergeStateStatus?.toUpperCase() ?? ""));
          const mergeMethod = input.method!.toUpperCase();
          await api.graphql(host, auto ? ENABLE_AUTO_MERGE_MUTATION : MERGE_MUTATION, {
            input: auto
              ? { pullRequestId: state.id, mergeMethod }
              : { pullRequestId: state.id, mergeMethod, expectedHeadOid: state.headRefOid },
          });
        }
      } catch (error) {
        // Show the new head (or whatever GitHub now says) before reporting why it failed.
        await refreshOne(link).catch(() => {});
        if (error instanceof AppError) throw error;
        throw new AppError("VALIDATION", messageOf(error));
      }
      try {
        await refreshOne(link);
      } catch (error) {
        logOnce(link.id, link.url, messageOf(error));
      }
    },
    async prHead(ref) {
      await requireSignedIn(ref.host);
      const [owner, name] = splitRepo(ref.repo);
      try {
        const raw = await api.graphql(ref.host, ACTION_STATE_QUERY, { owner, name, number: ref.number });
        const parsed = ActionState.safeParse(raw);
        if (!parsed.success) throw new Error("GitHub returned an unexpected PR shape");
        return parsed.data.repository.pullRequest.headRefOid;
      } catch (error) {
        throw new AppError("VALIDATION", messageOf(error));
      }
    },
    mergeIntoEpicBranch(link, input) {
      // A merge commit, never a squash or rebase: the epic's branch keeps each task's commits.
      return mergeChecked(link, { into: "epic", base: input.base, headOid: input.headOid, method: "merge" });
    },
    mergeIntoDefaultBranch(link, input) {
      return mergeChecked(link, { into: "default", base: input.base, headOid: input.headOid, method: input.method });
    },
    async ensureEpicPr(input) {
      await requireSignedIn(input.host);
      const [owner, name] = splitRepo(input.repo);
      try {
        const parsed = EpicPrData.safeParse(
          await api.graphql(input.host, EPIC_PR_QUERY, { owner, name, head: input.head }),
        );
        if (!parsed.success) throw new Error("GitHub returned an unexpected repository shape");
        const repository = parsed.data.repository;
        const base = repository.defaultBranchRef?.name;
        if (!base) throw new Error("Can't tell the repository's default branch");
        if (base === input.head) throw new Error(`The epic's branch can't be the default branch (${base})`);
        const open = repository.pullRequests.nodes.find((pr) => pr?.baseRefName === base);
        if (open) return { number: open.number, url: open.url, created: false };
        const created = CreatedPr.safeParse(
          await api.graphql(input.host, CREATE_PR_MUTATION, {
            input: {
              repositoryId: repository.id,
              baseRefName: base,
              headRefName: input.head,
              title: input.title,
              body: input.body,
              draft: true,
            },
          }),
        );
        if (!created.success) throw new Error("GitHub returned an unexpected PR shape");
        return { ...created.data.createPullRequest.pullRequest, created: true };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError("VALIDATION", messageOf(error));
      }
    },
    async setPrBody(ref, body) {
      await requireSignedIn(ref.host);
      const [owner, name] = splitRepo(ref.repo);
      try {
        const parsed = PrId.safeParse(await api.graphql(ref.host, PR_ID_QUERY, { owner, name, number: ref.number }));
        if (!parsed.success) throw new Error("GitHub returned an unexpected PR shape");
        await api.graphql(ref.host, UPDATE_PR_BODY_MUTATION, {
          input: { pullRequestId: parsed.data.repository.pullRequest.id, body },
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError("VALIDATION", messageOf(error));
      }
    },
    async reviewThreads(ref) {
      await requireSignedIn(ref.host);
      const [owner, name] = splitRepo(ref.repo);
      try {
        const parsed = ThreadState.safeParse(
          await api.graphql(ref.host, THREAD_STATE_QUERY, { owner, name, number: ref.number }),
        );
        if (!parsed.success) throw new Error("GitHub returned an unexpected PR shape");
        const pr = parsed.data.repository.pullRequest;
        return {
          headOid: pr.headRefOid,
          commits: pr.commits.nodes.flatMap((n) => (n ? [n.commit.oid] : [])),
          threads: mapReviewThreadDetails(pr.reviewThreads.nodes),
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError("VALIDATION", messageOf(error));
      }
    },
    async resolveReviewThread(host, threadId) {
      await requireSignedIn(host);
      try {
        await api.graphql(host, RESOLVE_THREAD_MUTATION, { threadId });
      } catch (error) {
        throw new AppError("VALIDATION", `GitHub couldn't resolve the review thread: ${messageOf(error)}`);
      }
    },
    async postReview(ref, input) {
      await requireSignedIn(ref.host);
      const [owner, name] = splitRepo(ref.repo);
      try {
        const raw = await api.graphql(ref.host, ACTION_STATE_QUERY, { owner, name, number: ref.number });
        const parsed = ActionState.safeParse(raw);
        if (!parsed.success) throw new Error("GitHub returned an unexpected PR shape");
        const { id, headRefOid: head } = parsed.data.repository.pullRequest;
        const sha = input.reviewedSha.toLowerCase();
        if (sha.length < 7 || !(head.toLowerCase().startsWith(sha) || sha.startsWith(head.toLowerCase()))) {
          throw new StaleReviewError(head, input.reviewedSha);
        }
        const post = (comments: readonly ReviewComment[], body: string) =>
          api.graphql(ref.host, POST_REVIEW_MUTATION, {
            input: {
              pullRequestId: id,
              commitOID: head,
              event: "COMMENT",
              body,
              ...(comments.length > 0
                ? { threads: comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })) }
                : {}),
            },
          });
        // GitHub can create the review and still answer with an error ("internal error, try again"): a review that is
        // there counts as posted, or the retry would review the same commit twice. Only after an error that may be
        // that: a clear refusal posted nothing, and an older review at this head must not stand in for it.
        const landed = async (error: unknown, folded: number): Promise<PostedReview | null> => {
          if (!isTransientGithubError(error)) return null;
          try {
            const found = await findPostedReview(ref, head, startedAt);
            return found ? { id: found.id, url: found.url, headOid: head, folded } : null;
          } catch {
            // The lookup failing says nothing: the original error is the one to report.
            return null;
          }
        };
        const startedAt = Date.now();
        let data: unknown;
        let folded = 0;
        try {
          data = await post(input.comments, input.body);
        } catch (error) {
          const already = await landed(error, 0);
          if (already) return already;
          // One comment on a line the diff doesn't touch refuses the whole review: say it in the body instead. A
          // failure that may pass (GitHub's own error, the network) is retried as it was, not changed.
          if (
            !(error instanceof GithubApiError) ||
            error.kind !== "response" ||
            isTransientGithubError(error) ||
            input.comments.length === 0
          ) {
            throw error;
          }
          try {
            data = await post([], foldReviewComments(input.body, input.comments));
          } catch (retryError) {
            const foldedReview = await landed(retryError, input.comments.length);
            if (foldedReview) return foldedReview;
            throw retryError;
          }
          folded = input.comments.length;
        }
        const posted = PostedReviewData.safeParse(data);
        if (!posted.success) throw new Error("GitHub returned an unexpected review shape");
        const review = posted.data.addPullRequestReview.pullRequestReview;
        return { id: review.databaseId ?? null, url: review.url, headOid: head, folded };
      } catch (error) {
        if (error instanceof AppError) throw error;
        // Say whose failure it is: the card would otherwise read like one of ours. The kind stays, so a caller can tell a
        // failure that may pass from one that won't.
        const message = `GitHub couldn't post the review: ${messageOf(error)}`;
        if (error instanceof GithubApiError) throw new GithubApiError(error.kind, error.host, message);
        throw new AppError("VALIDATION", message);
      }
    },
    start() {
      void checkStatus().then(() => pollAll());
      timers.push(setInterval(() => void checkStatus(), GH_STATUS_INTERVAL_MS).unref());
      timers.push(setInterval(() => void pollAll(), POLL_TICK_MS).unref());
    },
    stop() {
      for (const timer of timers.splice(0)) clearInterval(timer);
    },
  };
}

function splitRepo(repo: string): [string, string] {
  const slash = repo.indexOf("/");
  return [repo.slice(0, slash), repo.slice(slash + 1)];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** GitHub's message for the error whose path runs through the alias, if any. */
function errorFor(errors: readonly GraphqlError[], alias: string): string | null {
  return (errors.find((e) => e.path?.includes(alias)) ?? errors[0])?.message ?? null;
}

/** "3 unresolved review conversations". */
export const describeUnresolved = (count: number): string =>
  `${count} unresolved review conversation${count === 1 ? "" : "s"}`;

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
