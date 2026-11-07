import { GITHUB_HOST, PrMergeState, prReviewHeader, type PrRef, type PrSnapshot } from "@repo/contracts";
import { z } from "zod";
import { AppError } from "../errors.ts";
import { defaultRunGh, GhError, type RunGh } from "./gh.ts";
import {
  isTransientHostError,
  StaleReviewError,
  type GitHost,
  type MergeTarget,
  type PostedReview,
  type ReviewComment,
} from "./gitHost.ts";
import { createGhTokens, createGithubApi, GithubApiError, type GithubApi, type GraphqlError } from "./githubApi.ts";
import { createGithubReads } from "./githubReads.ts";
import { createGithubRepoPrs } from "./githubRepoPrs.ts";
import {
  allowedMergeMethods,
  GraphqlPr,
  GraphqlRepo,
  mapPrSnapshot,
  mapReviewThreadDetails,
  pollQuery,
  THREAD_STATE_QUERY,
  ThreadState,
} from "./githubSnapshot.ts";
import { createGhStatus, GH_STATUS_INTERVAL_MS } from "./githubStatus.ts";
import type { FetchFn } from "./t3.ts";
import { messageOf } from "./util.ts";

// GitHub's GitHost: GraphQL and REST with the token gh holds for each host (ADR 0006). The board's own rules (which PRs
// to poll, when, the merge guards) are host-neutral and live in prPoller.ts and prMerge.ts.

// ── Queries and mutations ────────────────────────────────────────────────

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

const RESOLVE_THREAD_MUTATION = `mutation ResolveReviewThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`;

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

const MERGE_TARGET_QUERY = `query PullRequestMergeTarget($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
    defaultBranchRef { name }
    pullRequest(number: $number) { id state headRefOid baseRefName mergeStateStatus }
  }
}`;
const MergeTargetData = z.object({
  repository: z.object({
    mergeCommitAllowed: z.boolean().nullish(),
    squashMergeAllowed: z.boolean().nullish(),
    rebaseMergeAllowed: z.boolean().nullish(),
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

// ── Reviews ──────────────────────────────────────────────────────────────

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

const REVIEW_EVENTS = { comment: "COMMENT", approve: "APPROVE", request_changes: "REQUEST_CHANGES" } as const;

// ── Merges ───────────────────────────────────────────────────────────────

/** GitHub refusing a merge method the repository's settings or a ruleset don't allow. */
const METHOD_NOT_ALLOWED =
  /\b(?:not|n't|never) (?:allowed|permitted)\b|\bnot enabled\b|\bmust not contain merge commits\b|\blinear history\b/i;

/** States in which GitHub merges at once rather than waiting, as `gh pr merge --auto` treats them. */
const IMMEDIATELY_MERGEABLE = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

const asMergeState = (value: string | null | undefined): MergeTarget["mergeState"] => {
  const parsed = PrMergeState.safeParse(value?.toLowerCase());
  return parsed.success ? parsed.data : value ? "unknown" : undefined;
};

// ── Issues ───────────────────────────────────────────────────────────────

const SubIssueJson = z.object({ html_url: z.string() }).loose();

// ── Hints ────────────────────────────────────────────────────────────────

/** gh's `--hostname` for a host other than github.com, which gh assumes. */
export const ghHostFlag = (host: string) => (host.toLowerCase() === "github.com" ? "" : ` --hostname ${host}`);

/** The commands an agent fixing the PR runs: gh takes the PR's URL for any repository and host. */
export function githubAgentHints(pr: { host: string; repo: string; number: number }) {
  const url = `https://${pr.host}/${pr.repo}/pull/${pr.number}`;
  const api = `repos/${pr.repo}/pulls/${pr.number}`;
  const flag = ghHostFlag(pr.host);
  return {
    checks: `gh pr checks ${url}`,
    runLog: "gh run view <run id> --log-failed",
    baseBranch: `gh pr view ${url} --json baseRefName`,
    conversation: `gh pr view ${url} --comments`,
    inlineComments: `gh api ${api}/comments${flag}`,
    review: (id: number) => `gh api ${api}/reviews/${id}${flag}`,
    reviewComments: (id: number) => `gh api ${api}/reviews/${id}/comments${flag}`,
    comment: `gh api repos/${pr.repo}/pulls/comments/<comment id>${flag}`,
    reply: (file: string) => `gh api ${api}/comments/<comment id>/replies -F body=@${file}${flag}`,
  };
}

// ── The host ─────────────────────────────────────────────────────────────

const GITHUB = "github.com";

export function createGithubHost(deps: { runGh?: RunGh; fetch?: FetchFn } = {}): GitHost {
  const runGh = deps.runGh ?? defaultRunGh;
  const tokens = createGhTokens({ runGh });
  const api: GithubApi = createGithubApi({ tokens, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const gh = createGhStatus(runGh);
  const repoPrs = createGithubRepoPrs(api);
  const timers: NodeJS.Timeout[] = [];

  const claims = (host: string): boolean => {
    const h = host.toLowerCase();
    return GITHUB_HOST.claimsHost(h) || gh.signedInHosts().some((s) => s.host === h);
  };
  const polls = (host: string): boolean => claims(host) && gh.signedInTo(host);

  const requireSignedIn = async (host: string): Promise<void> => {
    const current = await gh.ensure();
    if (!current.available) throw new AppError("VALIDATION", "GitHub CLI (gh) is not installed");
    if (!polls(host)) {
      throw new AppError(
        "VALIDATION",
        `GitHub CLI (gh) is not signed in to ${host}: run \`${GITHUB_HOST.cli.loginCommand(host)}\``,
      );
    }
  };

  /** Runs `fn`, turning anything but an AppError into one with the failure's message. */
  const asAppError = async <T>(fn: () => Promise<T>, prefix = ""): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("VALIDATION", `${prefix}${messageOf(error)}`);
    }
  };

  const readSnapshot = async (ref: PrRef): Promise<PrSnapshot> => {
    const [owner, name] = splitRepo(ref.repo);
    const { query, variables } = pollQuery([ref.number]);
    const data = await api.graphql(ref.host, query, { owner, name, ...variables });
    const repository = (data as { repository?: Record<string, unknown> | null } | null)?.repository;
    const pr = GraphqlPr.safeParse(repository?.pr0);
    const repo = GraphqlRepo.safeParse(repository);
    if (!pr.success || !repo.success) throw new Error("GitHub returned an unexpected PR shape");
    return mapPrSnapshot(pr.data, repo.data);
  };

  const actionState = async (ref: PrRef) => {
    const [owner, name] = splitRepo(ref.repo);
    const parsed = ActionState.safeParse(
      await api.graphql(ref.host, ACTION_STATE_QUERY, { owner, name, number: ref.number }),
    );
    if (!parsed.success) throw new Error("GitHub returned an unexpected PR shape");
    return parsed.data.repository.pullRequest;
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

  return {
    kind: "github",
    definition: GITHUB_HOST,
    capabilities: { autoMerge: true, reviewThreads: true, subIssues: true, createRepo: true },
    ...createGithubReads(api),

    status: () => gh.current(),
    checkStatus: () => gh.check(),
    ensureStatus: () => gh.ensure(),
    claims,
    reaches: (host) => gh.signedInTo(host.toLowerCase()),
    requireSignedIn,
    holdsTasks: (host) => {
      const h = host.toLowerCase();
      return h === GITHUB || polls(h);
    },

    async readSnapshots(host, repo, numbers) {
      const [owner, name] = splitRepo(repo);
      const { query, variables } = pollQuery(numbers);
      const { data, errors } = await api.graphqlBatch(host, query, { owner, name, ...variables });
      const repository = (data as { repository?: Record<string, unknown> | null } | null)?.repository ?? null;
      const repoParsed = repository ? GraphqlRepo.safeParse(repository) : null;
      return numbers.map((_, i) => {
        const pr = repository?.[`pr${i}`];
        const parsed = pr ? GraphqlPr.safeParse(pr) : null;
        if (parsed?.success && repoParsed?.success) return mapPrSnapshot(parsed.data, repoParsed.data);
        return {
          error: errorFor(errors, `pr${i}`) ?? (pr ? "GitHub returned an unexpected PR shape" : "PR not found"),
        };
      });
    },
    readSnapshot,

    async merge(ref, input) {
      // Read fresh rather than from the snapshot: the merge queue decides which mutation a merge is.
      const state = await actionState(ref);
      if (input.action === "disable_auto") {
        await api.graphql(ref.host, DISABLE_AUTO_MERGE_MUTATION, { pullRequestId: state.id });
        return;
      }
      if (input.expectedHeadOid && input.expectedHeadOid !== state.headRefOid) {
        throw new AppError("CONFLICT", "The PR has new commits since it was last checked. Review them, then merge.");
      }
      const auto =
        state.isMergeQueueEnabled === true ||
        (input.action === "auto" && !IMMEDIATELY_MERGEABLE.has(state.mergeStateStatus?.toUpperCase() ?? ""));
      const mergeMethod = input.method!.toUpperCase();
      await api.graphql(ref.host, auto ? ENABLE_AUTO_MERGE_MUTATION : MERGE_MUTATION, {
        input: auto
          ? { pullRequestId: state.id, mergeMethod }
          : { pullRequestId: state.id, mergeMethod, expectedHeadOid: state.headRefOid },
      });
    },
    async mergeTarget(ref) {
      const [owner, name] = splitRepo(ref.repo);
      const raw = await api.graphql(ref.host, MERGE_TARGET_QUERY, { owner, name, number: ref.number });
      const parsed = MergeTargetData.safeParse(raw);
      if (!parsed.success) throw new Error("GitHub returned an unexpected PR shape");
      const { pullRequest: pr, defaultBranchRef } = parsed.data.repository;
      const state = pr.state.toUpperCase();
      return {
        id: pr.id,
        state: state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : "open",
        headOid: pr.headRefOid,
        base: pr.baseRefName,
        defaultBranch: defaultBranchRef?.name ?? null,
        mergeState: asMergeState(pr.mergeStateStatus),
        mergeMethods: allowedMergeMethods(parsed.data.repository),
      };
    },
    async mergeAt(ref, target, methods) {
      let refused: unknown;
      for (const method of methods) {
        try {
          await api.graphql(ref.host, MERGE_MUTATION, {
            input: { pullRequestId: target.id, mergeMethod: method.toUpperCase(), expectedHeadOid: target.headOid },
          });
          return method;
        } catch (error) {
          // Only a refusal of the method itself moves on to the next; anything else (a conflict, a stale head) won't
          // change with another method.
          if (!METHOD_NOT_ALLOWED.test(messageOf(error))) throw error;
          refused = error;
        }
      }
      throw refused;
    },
    async prHead(ref) {
      await requireSignedIn(ref.host);
      return asAppError(async () => (await actionState(ref)).headRefOid);
    },
    async postReview(ref, input) {
      await requireSignedIn(ref.host);
      try {
        const { id, headRefOid: head } = await actionState(ref);
        const sha = input.reviewedSha.toLowerCase();
        if (sha.length < 7 || !(head.toLowerCase().startsWith(sha) || sha.startsWith(head.toLowerCase()))) {
          throw new StaleReviewError(head, input.reviewedSha);
        }
        const post = (comments: readonly ReviewComment[], body: string) =>
          api.graphql(ref.host, POST_REVIEW_MUTATION, {
            input: {
              pullRequestId: id,
              commitOID: head,
              event: REVIEW_EVENTS[input.event ?? "comment"],
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
          if (!isTransientHostError(error)) return null;
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
            isTransientHostError(error) ||
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
        // Say whose failure it is: the card would otherwise read like one of ours. The reason stays, so a caller can
        // tell a failure that may pass from one that won't.
        const message = `GitHub couldn't post the review: ${messageOf(error)}`;
        if (error instanceof GithubApiError) throw new GithubApiError(error.kind, error.host, message);
        throw new AppError("VALIDATION", message);
      }
    },
    async reviewThreads(ref) {
      await requireSignedIn(ref.host);
      const [owner, name] = splitRepo(ref.repo);
      return asAppError(async () => {
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
      });
    },
    async listOpenPrs(host, repo) {
      await requireSignedIn(host);
      return asAppError(() => repoPrs.listOpenPrs(host, repo));
    },
    async readRepoPr(ref) {
      await requireSignedIn(ref.host);
      return asAppError(() => repoPrs.readRepoPr(ref));
    },
    async unchangedSince(ref, base, head, baseRef) {
      await requireSignedIn(ref.host);
      return asAppError(() => repoPrs.unchangedSince(ref, base, head, baseRef));
    },
    async postComment(ref, body) {
      await requireSignedIn(ref.host);
      return asAppError(() => repoPrs.postComment(ref, body), "GitHub couldn't post the comment: ");
    },
    async editComment(host, nodeId, body) {
      await requireSignedIn(host);
      return asAppError(() => repoPrs.editComment(host, nodeId, body), "GitHub couldn't edit the comment: ");
    },
    async replyOnThread(host, threadId, body) {
      await requireSignedIn(host);
      await asAppError(() => repoPrs.replyOnThread(host, threadId, body), "GitHub couldn't reply on the thread: ");
    },
    async resolveReviewThread(host, threadId) {
      await requireSignedIn(host);
      try {
        await api.graphql(host, RESOLVE_THREAD_MUTATION, { threadId });
      } catch (error) {
        throw new AppError("VALIDATION", `GitHub couldn't resolve the review thread: ${messageOf(error)}`);
      }
    },
    async ensurePr(input) {
      await requireSignedIn(input.host);
      const [owner, name] = splitRepo(input.repo);
      return asAppError(async () => {
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
      });
    },
    async setPrBody(ref, body) {
      await requireSignedIn(ref.host);
      const [owner, name] = splitRepo(ref.repo);
      await asAppError(async () => {
        const parsed = PrId.safeParse(await api.graphql(ref.host, PR_ID_QUERY, { owner, name, number: ref.number }));
        if (!parsed.success) throw new Error("GitHub returned an unexpected PR shape");
        await api.graphql(ref.host, UPDATE_PR_BODY_MUTATION, {
          input: { pullRequestId: parsed.data.repository.pullRequest.id, body },
        });
      });
    },
    async listSubIssues(ref) {
      const path = `/repos/${ref.repo
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/")}/issues/${ref.number}/sub_issues`;
      const urls: string[] = [];
      // GitHub serves at most 100 a page, and an issue holds at most 100 sub-issues.
      for (let page = 1; page <= 10; page += 1) {
        const body = await api.rest(ref.host, `${path}?per_page=100&page=${page}`);
        const items = z.array(SubIssueJson).safeParse(body);
        if (!items.success) throw new Error("GitHub's answer for the sub-issues wasn't in the expected shape");
        urls.push(...items.data.map((i) => i.html_url).filter((u) => /^https?:\/\//.test(u)));
        if (items.data.length < 100) break;
      }
      return [...new Set(urls)];
    },
    async createRepo(name, opts) {
      let stdout: string;
      try {
        stdout = await runGh(["repo", "create", name, "--private", "--description", opts.description]);
      } catch (error) {
        const message = messageOf(error);
        // The caller words this one, as it knows whose account it is.
        if (/already exists/i.test(message)) throw new AppError("CONFLICT", message);
        throw new AppError("INTERNAL", `gh repo create: ${message}`);
      }
      // gh prints the new repo's page; owner/name come from it, since gh may have been signed in as someone else.
      const webUrl = stdout
        .trim()
        .split(/\s+/)
        .find((word) => /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(word));
      if (!webUrl) throw new AppError("INTERNAL", `gh repo create printed no repo URL: ${stdout.trim()}`);
      // Push the way gh tells git to: over SSH when the user chose that, else HTTPS, which gh signs git in for.
      const protocol = await runGh(["config", "get", "git_protocol", "--host", GITHUB])
        .then((out) => out.trim())
        .catch((error: unknown) => (error instanceof GhError ? "" : Promise.reject(error)));
      const path = webUrl.slice(`https://${GITHUB}/`.length);
      return { webUrl, pushUrl: protocol === "ssh" ? `git@${GITHUB}:${path}.git` : `${webUrl}.git` };
    },
    agentHints: githubAgentHints,

    start() {
      void gh.check();
      timers.push(setInterval(() => void gh.check(), GH_STATUS_INTERVAL_MS).unref());
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

/** GitHub's message for the error whose path runs through the alias, if any. */
function errorFor(errors: readonly GraphqlError[], alias: string): string | null {
  return (errors.find((e) => e.path?.includes(alias)) ?? errors[0])?.message ?? null;
}
