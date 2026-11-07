import type { PrRef } from "@repo/contracts";
import { z } from "zod";
import type { OpenPrListing, PostedComment, RepoPr } from "./gitHost.ts";
import type { GithubApi } from "./githubApi.ts";

// GitHub's side of Review PRs' other-people's-PRs source (docs/features/autopilot.md#other-peoples-prs): the open PRs of
// a repository, one PR read in full (history, threads, checks), whether a push changed anything the author wrote, and
// the comments Autopilot posts and edits. Everything is mapped to the host-neutral RepoPr in gitHost.ts.

const OPEN_PRS_QUERY = `query RepoOpenPullRequests($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: [OPEN], first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number isDraft author { login } }
    }
  }
}`;
const OpenPrs = z.object({
  repository: z.object({
    pullRequests: z.object({
      nodes: z.array(
        z
          .object({ number: z.number(), isDraft: z.boolean(), author: z.object({ login: z.string() }).nullish() })
          .nullable(),
      ),
    }),
  }),
});

/**
 * One PR in full. Only the head commit's checks are read (with `isRequired`, so only what the base branch requires
 * decides), and each list is the host's newest 100, as the custom automation this replaces read them.
 */
export const REPO_PR_QUERY = `query RepoPullRequest($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number url title state isDraft author { login } headRefOid headRefName baseRefName isCrossRepository
      baseRef { branchProtectionRule { requiredStatusCheckContexts } }
      closingIssuesReferences(first: 10) { nodes { number } }
      files(first: 100) { totalCount nodes { path } }
      commits(last: 100) { nodes { commit { oid committedDate parents { totalCount } } } }
      head: commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: 100) { nodes {
        kind: __typename
        ... on CheckRun { name databaseId status conclusion completedAt isRequired(pullRequestNumber: $number)
          checkSuite { app { databaseId } workflowRun { workflow { databaseId } } } }
        ... on StatusContext { context state createdAt isRequired(pullRequestNumber: $number) }
      } } } } } }
      latestReviews(first: 30) { nodes { author { login } state body } }
      reviews(last: 100) { nodes { databaseId author { login } state body submittedAt commit { oid } } }
      comments(last: 100) { nodes { id databaseId url author { login } body createdAt lastEditedAt } }
      reviewThreads(first: 100) { nodes { id isResolved viewerCanResolve
        comments(first: 50) { nodes { databaseId author { login } body createdAt path line } }
      } }
      timelineItems(last: 100, itemTypes: [REVIEW_DISMISSED_EVENT, CROSS_REFERENCED_EVENT]) { nodes {
        kind: __typename
        ... on ReviewDismissedEvent { createdAt previousReviewState actor { login }
          review { author { login } body submittedAt commit { oid } } }
        ... on CrossReferencedEvent { source { kind: __typename ... on Issue { number state repository { nameWithOwner } } } }
      } }
    }
  }
}`;

const Login = z.object({ login: z.string() }).nullish();
const Commit = z.object({ oid: z.string() }).nullish();
const nodes = <T extends z.ZodTypeAny>(item: T) => z.object({ nodes: z.array(item.nullable()) });

const CheckItem = z
  .object({
    kind: z.string().optional(),
    name: z.string().nullish(),
    context: z.string().nullish(),
    databaseId: z.number().nullish(),
    status: z.string().nullish(),
    conclusion: z.string().nullish(),
    state: z.string().nullish(),
    completedAt: z.string().nullish(),
    createdAt: z.string().nullish(),
    isRequired: z.boolean().nullish(),
    checkSuite: z
      .object({
        app: z.object({ databaseId: z.number().nullish() }).nullish(),
        workflowRun: z.object({ workflow: z.object({ databaseId: z.number().nullish() }).nullish() }).nullish(),
      })
      .nullish(),
  })
  .loose();
type CheckItem = z.infer<typeof CheckItem>;

export const RepoPrData = z.object({
  viewer: z.object({ login: z.string() }),
  repository: z.object({
    pullRequest: z.object({
      number: z.number(),
      url: z.string(),
      title: z.string(),
      state: z.string(),
      isDraft: z.boolean(),
      author: Login,
      headRefOid: z.string(),
      headRefName: z.string(),
      baseRefName: z.string(),
      baseRef: z
        .object({
          branchProtectionRule: z.object({ requiredStatusCheckContexts: z.array(z.string()).nullish() }).nullish(),
        })
        .nullish(),
      isCrossRepository: z.boolean().nullish(),
      closingIssuesReferences: nodes(z.object({ number: z.number() })).nullish(),
      files: z.object({ totalCount: z.number(), nodes: z.array(z.object({ path: z.string() }).nullable()) }).nullish(),
      commits: nodes(
        z.object({
          commit: z.object({
            oid: z.string(),
            committedDate: z.string(),
            parents: z.object({ totalCount: z.number() }),
          }),
        }),
      ),
      head: nodes(
        z.object({
          commit: z.object({
            oid: z.string(),
            statusCheckRollup: z.object({ contexts: nodes(CheckItem) }).nullish(),
          }),
        }),
      ),
      latestReviews: nodes(z.object({ author: Login, state: z.string(), body: z.string().nullish() })).nullish(),
      reviews: nodes(
        z.object({
          databaseId: z.number().nullish(),
          author: Login,
          state: z.string(),
          body: z.string().nullish(),
          submittedAt: z.string().nullish(),
          commit: Commit,
        }),
      ).nullish(),
      comments: nodes(
        z.object({
          id: z.string(),
          databaseId: z.number().nullish(),
          url: z.string(),
          author: Login,
          body: z.string().nullish(),
          createdAt: z.string(),
          lastEditedAt: z.string().nullish(),
        }),
      ).nullish(),
      reviewThreads: nodes(
        z.object({
          id: z.string(),
          isResolved: z.boolean(),
          viewerCanResolve: z.boolean().nullish(),
          comments: nodes(
            z.object({
              databaseId: z.number().nullish(),
              author: Login,
              body: z.string().nullish(),
              createdAt: z.string(),
              path: z.string().nullish(),
              line: z.number().nullish(),
            }),
          ),
        }),
      ).nullish(),
      timelineItems: nodes(
        z
          .object({
            kind: z.string().optional(),
            createdAt: z.string().nullish(),
            previousReviewState: z.string().nullish(),
            actor: Login,
            review: z
              .object({ author: Login, body: z.string().nullish(), submittedAt: z.string().nullish(), commit: Commit })
              .nullish(),
            source: z
              .object({
                kind: z.string().optional(),
                number: z.number().nullish(),
                state: z.string().nullish(),
                repository: z.object({ nameWithOwner: z.string() }).nullish(),
              })
              .nullish(),
          })
          .loose(),
      ).nullish(),
    }),
  }),
});
export type RepoPrData = z.input<typeof RepoPrData>;

const lower = (login: { login: string } | null | undefined): string | null => login?.login.toLowerCase() ?? null;
const present = <T>(items: ReadonlyArray<T | null> | undefined | null): T[] =>
  (items ?? []).filter((x): x is T => x !== null);

const GREEN_RUN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/** A check's name: a CheckRun's `name`, a StatusContext's `context`. */
const checkName = (c: CheckItem): string => c.name ?? c.context ?? "unnamed check";

/** Each check's newest run only, as GitHub's merge box judges it (a re-run or a cancelled run doesn't count). */
function newestRuns(items: readonly CheckItem[]): CheckItem[] {
  const key = (c: CheckItem) => {
    if (!c.name || c.databaseId == null) return null;
    const workflow = c.checkSuite?.workflowRun?.workflow?.databaseId;
    return `${workflow != null ? `w${workflow}` : `a${c.checkSuite?.app?.databaseId ?? ""}`}\u0000${c.name}`;
  };
  const newest = new Map<string, number>();
  for (const c of items) {
    const k = key(c);
    if (k) newest.set(k, Math.max(newest.get(k) ?? -Infinity, c.databaseId ?? -Infinity));
  }
  return items.filter((c) => {
    const k = key(c);
    return k === null || c.databaseId === newest.get(k);
  });
}

/**
 * The head's checks: pending, failing and, from the rulesets, required checks that haven't reported. Only the required
 * ones count when the base branch requires any (GitHub's merge box ignores the rest); otherwise every check does.
 */
export function mapRepoPrChecks(items: readonly CheckItem[], requiredContexts: readonly string[]): RepoPr["checks"] {
  const runs = newestRuns(items);
  const requiredNames = new Set(requiredContexts);
  const required = runs.filter((c) => c.isRequired === true || requiredNames.has(checkName(c)));
  const counted = required.length > 0 || requiredNames.size > 0 ? required : runs;
  const pending: string[] = [];
  const failing: string[] = [];
  let latestAt: string | null = null;
  for (const c of counted) {
    const finished = c.kind === "StatusContext" || c.state ? c.createdAt : c.completedAt;
    if (c.state) {
      const state = c.state.toUpperCase();
      if (state === "PENDING" || state === "EXPECTED") pending.push(checkName(c));
      else if (state !== "SUCCESS") failing.push(checkName(c));
    } else if ((c.status ?? "").toUpperCase() !== "COMPLETED") pending.push(checkName(c));
    else if (!GREEN_RUN.has((c.conclusion ?? "").toUpperCase())) failing.push(checkName(c));
    if (finished && !pending.includes(checkName(c)) && (!latestAt || finished > latestAt)) latestAt = finished;
  }
  const reported = new Set(runs.map(checkName));
  const missing = [...requiredNames].filter((name) => !reported.has(name));
  const unique = (xs: string[]) => [...new Set(xs)].sort();
  return { pending: unique(pending), failing: unique(failing), missing: unique(missing), latestAt };
}

/** Maps the detail query's answer (and the base branch's required checks) to a RepoPr. */
export function mapRepoPr(raw: unknown, repo: string, requiredContexts: readonly string[]): RepoPr {
  const parsed = RepoPrData.safeParse(raw);
  if (!parsed.success) throw new Error("GitHub returned an unexpected PR shape");
  const pr = parsed.data.repository.pullRequest;
  const state = pr.state.toUpperCase();
  const head = present(pr.head.nodes).at(-1)?.commit;
  const checks = present(head?.statusCheckRollup?.contexts.nodes);
  const sameRepo = repo.toLowerCase();
  const timeline = present(pr.timelineItems?.nodes);
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    author: lower(pr.author),
    draft: pr.isDraft,
    state: state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : "open",
    headOid: pr.headRefOid,
    headRef: pr.headRefName,
    baseRef: pr.baseRefName,
    isCrossRepository: pr.isCrossRepository ?? false,
    viewer: parsed.data.viewer.login.toLowerCase(),
    closingIssues: present(pr.closingIssuesReferences?.nodes).map((n) => n.number),
    referencingIssues: [
      ...new Set(
        timeline.flatMap((t) =>
          t.source?.kind === "Issue" &&
          typeof t.source.number === "number" &&
          (t.source.state ?? "").toUpperCase() === "OPEN" &&
          t.source.repository?.nameWithOwner.toLowerCase() === sameRepo
            ? [t.source.number]
            : [],
        ),
      ),
    ],
    files: {
      total: pr.files?.totalCount ?? 0,
      paths: present(pr.files?.nodes).map((f) => f.path),
    },
    commits: present(pr.commits.nodes).map((n) => ({
      oid: n.commit.oid,
      committedDate: n.commit.committedDate,
      parents: n.commit.parents.totalCount,
    })),
    // Required by the rulesets (read by the caller) or by classic branch protection (read here).
    checks: mapRepoPrChecks(checks, [
      ...new Set([...requiredContexts, ...(pr.baseRef?.branchProtectionRule?.requiredStatusCheckContexts ?? [])]),
    ]),
    latestReviews: present(pr.latestReviews?.nodes).map((r) => ({
      author: lower(r.author),
      state: r.state.toUpperCase(),
      body: r.body ?? "",
    })),
    reviews: present(pr.reviews?.nodes).map((r) => ({
      id: r.databaseId ?? null,
      author: lower(r.author),
      state: r.state.toUpperCase(),
      body: r.body ?? "",
      submittedAt: r.submittedAt ?? null,
      commitOid: r.commit?.oid ?? null,
    })),
    comments: present(pr.comments?.nodes).flatMap((c) =>
      typeof c.databaseId === "number"
        ? [
            {
              id: c.databaseId,
              nodeId: c.id,
              url: c.url,
              author: lower(c.author),
              body: c.body ?? "",
              createdAt: c.createdAt,
              editedAt: c.lastEditedAt ?? null,
            },
          ]
        : [],
    ),
    threads: present(pr.reviewThreads?.nodes).map((t) => ({
      id: t.id,
      resolved: t.isResolved,
      canResolve: t.viewerCanResolve ?? false,
      comments: present(t.comments.nodes).flatMap((c) =>
        typeof c.databaseId === "number"
          ? [
              {
                id: c.databaseId,
                author: lower(c.author),
                body: c.body ?? "",
                createdAt: c.createdAt,
                path: c.path ?? null,
                line: c.line ?? null,
              },
            ]
          : [],
      ),
    })),
    dismissals: timeline.flatMap((t) =>
      t.kind === "ReviewDismissedEvent" && t.createdAt
        ? [
            {
              createdAt: t.createdAt,
              actor: lower(t.actor),
              previousState: (t.previousReviewState ?? "").toUpperCase(),
              review: t.review
                ? {
                    author: lower(t.review.author),
                    body: t.review.body ?? "",
                    submittedAt: t.review.submittedAt ?? null,
                    commitOid: t.review.commit?.oid ?? null,
                  }
                : null,
            },
          ]
        : [],
    ),
  };
}

const RulesJson = z.array(
  z
    .object({
      type: z.string(),
      parameters: z
        .object({ required_status_checks: z.array(z.object({ context: z.string() }).loose()).optional() })
        .loose()
        .nullish(),
    })
    .loose(),
);

const CompareJson = z
  .object({
    status: z.string(),
    files: z.array(z.object({ filename: z.string(), patch: z.string().optional() }).loose()).optional(),
  })
  .loose();

/** A patch with its hunk headers' line numbers dropped, so the same change on a moved base compares equal. */
const normalizePatch = (patch: string): string => patch.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/gm, "@@");

/** GitHub serves at most 300 files in a compare; past that it can't tell. */
const COMPARE_FILE_LIMIT = 300;

const ADD_COMMENT_MUTATION = `mutation AddPullRequestComment($input: AddCommentInput!) {
  addComment(input: $input) { commentEdge { node { id databaseId url } } }
}`;
const AddedComment = z.object({
  addComment: z.object({
    commentEdge: z.object({ node: z.object({ id: z.string(), databaseId: z.number(), url: z.string() }) }),
  }),
});
const EDIT_COMMENT_MUTATION = `mutation EditPullRequestComment($input: UpdateIssueCommentInput!) {
  updateIssueComment(input: $input) { issueComment { id databaseId url } }
}`;
const EditedComment = z.object({
  updateIssueComment: z.object({
    issueComment: z.object({ id: z.string(), databaseId: z.number(), url: z.string() }),
  }),
});
const THREAD_REPLY_MUTATION = `mutation ReplyOnReviewThread($input: AddPullRequestReviewThreadReplyInput!) {
  addPullRequestReviewThreadReply(input: $input) { comment { id } }
}`;
const PR_ID_QUERY = `query PullRequestNodeId($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
}`;
const PrId = z.object({ repository: z.object({ pullRequest: z.object({ id: z.string() }) }) });

const splitRepo = (repo: string): [string, string] => {
  const slash = repo.indexOf("/");
  return [repo.slice(0, slash), repo.slice(slash + 1)];
};
const repoPath = (repo: string) =>
  repo
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

/** GitHub's reads and writes for other people's PRs, over the API gh's token signs. */
export function createGithubRepoPrs(api: GithubApi) {
  /** The checks the base branch's rulesets require; none when they can't be read (the merge box's `isRequired` still applies). */
  const requiredContexts = async (host: string, repo: string, branch: string): Promise<string[]> => {
    try {
      const raw = await api.rest(host, `/repos/${repoPath(repo)}/rules/branches/${encodeURIComponent(branch)}`);
      const rules = RulesJson.safeParse(raw);
      if (!rules.success) return [];
      return [
        ...new Set(
          rules.data.flatMap((r) =>
            r.type === "required_status_checks"
              ? (r.parameters?.required_status_checks ?? []).map((c) => c.context)
              : [],
          ),
        ),
      ];
    } catch {
      return [];
    }
  };

  const compare = async (host: string, repo: string, base: string, head: string) => {
    const raw = await api.rest(
      host,
      `/repos/${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
    const parsed = CompareJson.safeParse(raw);
    if (!parsed.success) throw new Error("GitHub returned an unexpected compare shape");
    return parsed.data;
  };

  const prNodeId = async (ref: PrRef): Promise<string> => {
    const [owner, name] = splitRepo(ref.repo);
    const parsed = PrId.safeParse(await api.graphql(ref.host, PR_ID_QUERY, { owner, name, number: ref.number }));
    if (!parsed.success) throw new Error("GitHub returned an unexpected PR shape");
    return parsed.data.repository.pullRequest.id;
  };

  return {
    async listOpenPrs(host: string, repo: string): Promise<OpenPrListing[]> {
      const [owner, name] = splitRepo(repo);
      const parsed = OpenPrs.safeParse(await api.graphql(host, OPEN_PRS_QUERY, { owner, name }));
      if (!parsed.success) throw new Error("GitHub returned an unexpected pull request list");
      return present(parsed.data.repository.pullRequests.nodes).map((n) => ({
        number: n.number,
        author: lower(n.author),
        draft: n.isDraft,
      }));
    },

    async readRepoPr(ref: PrRef): Promise<RepoPr> {
      const [owner, name] = splitRepo(ref.repo);
      const raw = await api.graphql(ref.host, REPO_PR_QUERY, { owner, name, number: ref.number });
      const base = RepoPrData.safeParse(raw);
      const branch = base.success ? base.data.repository.pullRequest.baseRefName : null;
      const required = branch ? await requiredContexts(ref.host, ref.repo, branch) : [];
      return mapRepoPr(raw, ref.repo, required);
    },

    /**
     * Whether nothing the author wrote changed between two heads: the PR's change against `baseRef` is the same patch
     * before and after (hunk line numbers aside), which holds after merging the base branch in or rebasing onto it, and
     * fails for a merge of any other branch or an edited merge. A file GitHub serves no patch for (binary, too large)
     * can't be compared, so it counts as changed.
     */
    async unchangedSince(ref: PrRef, base: string, head: string, baseRef: string): Promise<boolean> {
      if (base === head) return true;
      const [before, after] = await Promise.all([
        compare(ref.host, ref.repo, baseRef, base),
        compare(ref.host, ref.repo, baseRef, head),
      ]);
      const files = (c: typeof before) => c.files ?? [];
      if (files(before).length >= COMPARE_FILE_LIMIT || files(after).length >= COMPARE_FILE_LIMIT) return false;
      const patches = (c: typeof before): Map<string, string> | null => {
        const map = new Map<string, string>();
        for (const f of files(c)) {
          if (typeof f.patch !== "string") return null;
          map.set(f.filename, normalizePatch(f.patch));
        }
        return map;
      };
      const a = patches(before);
      const b = patches(after);
      if (!a || !b) return false;
      return a.size === b.size && [...a].every(([file, patch]) => b.get(file) === patch);
    },

    async postComment(ref: PrRef, body: string): Promise<PostedComment> {
      const subjectId = await prNodeId(ref);
      const parsed = AddedComment.safeParse(
        await api.graphql(ref.host, ADD_COMMENT_MUTATION, { input: { subjectId, body } }),
      );
      if (!parsed.success) throw new Error("GitHub returned an unexpected comment shape");
      const node = parsed.data.addComment.commentEdge.node;
      return { id: node.databaseId, nodeId: node.id, url: node.url };
    },

    async editComment(host: string, nodeId: string, body: string): Promise<PostedComment> {
      const parsed = EditedComment.safeParse(
        await api.graphql(host, EDIT_COMMENT_MUTATION, { input: { id: nodeId, body } }),
      );
      if (!parsed.success) throw new Error("GitHub returned an unexpected comment shape");
      const c = parsed.data.updateIssueComment.issueComment;
      return { id: c.databaseId, nodeId: c.id, url: c.url };
    },

    async replyOnThread(host: string, threadId: string, body: string): Promise<void> {
      await api.graphql(host, THREAD_REPLY_MUTATION, { input: { pullRequestReviewThreadId: threadId, body } });
    },
  };
}
