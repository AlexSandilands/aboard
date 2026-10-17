import type { RunGh } from "../integrations/gh.ts";
import type { GraphqlPr, GraphqlRepo } from "../integrations/github.ts";
import type { FetchFn } from "../integrations/t3.ts";

export interface FakePr extends GraphqlPr {
  /** What the fresh read before a merge reports. */
  mergeStateStatus?: string;
  isMergeQueueEnabled?: boolean;
}

/**
 * A stand-in for `gh` and GitHub's GraphQL API, holding PRs by `owner/name#number`. It answers the
 * poll, the pre-merge read and the three merge mutations, and records every request.
 */
export function createFakeGithub(opts: { hosts?: string[] } = {}) {
  const hosts = opts.hosts ?? ["github.com"];
  const prs = new Map<string, FakePr>();
  const repos = new Map<string, GraphqlRepo>();
  const requests: { url: string; operation: string; variables: Record<string, unknown> }[] = [];
  const mutations: { operation: string; input: Record<string, unknown> }[] = [];
  /** GitHub's error message for the next mutation, to test failures. */
  let failNextMutation: string | null = null;
  /** Refuse the next review that has inline threads, as GitHub does for a line outside the diff. */
  let failNextThreadedReview = false;
  let reviewCount = 0;

  const repoOf = (owner: string, name: string): GraphqlRepo | undefined =>
    repos.get(`${owner}/${name}`) ??
    ([...prs.keys()].some((k) => k.startsWith(`${owner}/${name}#`))
      ? {
          squashMergeAllowed: true,
          mergeCommitAllowed: true,
          rebaseMergeAllowed: false,
          autoMergeAllowed: true,
          viewerPermission: "WRITE",
        }
      : undefined);

  const prById = (id: unknown): FakePr => {
    const pr = [...prs.entries()].find(([key]) => `PR_${key}` === id)?.[1];
    if (!pr) throw new Error(`fake github: no PR ${String(id)}`);
    return pr;
  };

  const handle = (query: string, variables: Record<string, unknown>): unknown => {
    const operation = /^(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "anonymous";
    if (operation === "PollPullRequests") {
      const { owner, name } = variables as { owner: string; name: string };
      const repo = repoOf(owner, name);
      if (!repo) {
        return {
          data: { repository: null },
          errors: [{ type: "NOT_FOUND", path: ["repository"], message: `Could not resolve to a Repository` }],
        };
      }
      const repository: Record<string, unknown> = { ...repo };
      const errors: unknown[] = [];
      for (const [key, value] of Object.entries(variables)) {
        const match = /^n(\d+)$/.exec(key);
        if (!match) continue;
        const alias = `pr${match[1]}`;
        const pr = prs.get(`${owner}/${name}#${String(value)}`);
        repository[alias] = pr ? { ...pr, mergeStateStatus: undefined, isMergeQueueEnabled: undefined } : null;
        if (!pr) {
          errors.push({
            type: "NOT_FOUND",
            path: ["repository", alias],
            message: `Could not resolve to a PullRequest with the number of ${String(value)}.`,
          });
        }
      }
      return errors.length > 0 ? { data: { repository }, errors } : { data: { repository } };
    }
    if (operation === "PullRequestActionState") {
      const { owner, name, number } = variables as { owner: string; name: string; number: number };
      const key = `${owner}/${name}#${number}`;
      const pr = prs.get(key);
      if (!pr) return { data: null, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest" }] };
      return {
        data: {
          repository: {
            pullRequest: {
              id: `PR_${key}`,
              headRefOid: pr.headRefOid,
              isMergeQueueEnabled: pr.isMergeQueueEnabled ?? false,
              mergeStateStatus: pr.mergeStateStatus ?? "CLEAN",
            },
          },
        },
      };
    }
    if (operation === "PullRequestId") {
      const { owner, name, number } = variables as { owner: string; name: string; number: number };
      return { data: { repository: { pullRequest: { id: `PR_${owner}/${name}#${number}` } } } };
    }
    if (operation === "PullRequestMergeTarget") {
      const { owner, name, number } = variables as { owner: string; name: string; number: number };
      const key = `${owner}/${name}#${number}`;
      const pr = prs.get(key);
      if (!pr) return { data: null, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest" }] };
      return {
        data: {
          repository: {
            defaultBranchRef: { name: "main" },
            pullRequest: {
              id: `PR_${key}`,
              state: pr.state,
              headRefOid: pr.headRefOid,
              baseRefName: pr.baseRefName ?? "main",
            },
          },
        },
      };
    }
    if (operation === "EpicPullRequest") {
      const { owner, name, head } = variables as { owner: string; name: string; head: string };
      const nodes = [...prs.entries()]
        .filter(([key, pr]) => key.startsWith(`${owner}/${name}#`) && pr.headRefName === head && pr.state === "OPEN")
        .map(([key, pr]) => {
          const number = Number(key.slice(key.indexOf("#") + 1));
          return { number, url: `https://github.com/${owner}/${name}/pull/${number}`, baseRefName: pr.baseRefName };
        });
      return {
        data: {
          repository: { id: `R_${owner}/${name}`, defaultBranchRef: { name: "main" }, pullRequests: { nodes } },
        },
      };
    }
    const input = (variables.input ?? variables) as Record<string, unknown>;
    if (operation === "CreatePullRequest") {
      mutations.push({ operation, input });
      const repo = String(input.repositoryId).slice(2);
      const number = 100 + [...prs.keys()].filter((k) => k.startsWith(`${repo}#`)).length;
      prs.set(`${repo}#${number}`, {
        ...fakePr({ number, title: String(input.title) }),
        headRefName: String(input.headRefName),
        baseRefName: String(input.baseRefName),
        isDraft: input.draft === true,
      });
      return {
        data: { createPullRequest: { pullRequest: { number, url: `https://github.com/${repo}/pull/${number}` } } },
      };
    }
    mutations.push({ operation, input });
    if (failNextMutation) {
      const message = failNextMutation;
      failNextMutation = null;
      return { data: null, errors: [{ type: "UNPROCESSABLE", message }] };
    }
    const pr = prById(input.pullRequestId);
    if (operation === "PostPullRequestReview") {
      if (failNextThreadedReview && Array.isArray(input.threads)) {
        failNextThreadedReview = false;
        mutations.pop();
        mutations.push({ operation: `${operation} (refused)`, input });
        return { data: null, errors: [{ type: "UNPROCESSABLE", message: "Line must be part of the diff" }] };
      }
      reviewCount += 1;
      const id = 900 + reviewCount;
      return {
        data: {
          addPullRequestReview: {
            pullRequestReview: { databaseId: id, url: `https://github.com/o/r/pull/7#pullrequestreview-${id}` },
          },
        },
      };
    }
    if (operation === "MergePullRequest") pr.state = "MERGED";
    else if (operation === "EnableAutoMerge") pr.autoMergeRequest = { mergeMethod: String(input.mergeMethod) };
    else if (operation === "DisableAutoMerge") pr.autoMergeRequest = null;
    else if (operation === "UpdatePullRequestBody") return { data: { updatePullRequest: { clientMutationId: null } } };
    else throw new Error(`fake github: unknown operation ${operation}`);
    return { data: { [operation]: { clientMutationId: null } } };
  };

  const fetch: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body as string) as { query: string; variables: Record<string, unknown> };
    const operation = /^(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "anonymous";
    requests.push({ url, operation, variables: body.variables });
    return Response.json(handle(body.query, body.variables));
  };

  const runGh: RunGh = async (args) => {
    if (args[0] === "--version") return "gh version 2.96.0";
    if (args[0] === "auth" && args[1] === "status") {
      return JSON.stringify({
        hosts: Object.fromEntries(hosts.map((host) => [host, [{ state: "success", active: true, host, login: "me" }]])),
      });
    }
    // Built at runtime so no token-shaped literal sits in the source.
    if (args[0] === "auth" && args[1] === "token") return ["fake", "credential", args[3]].join("-");
    throw new Error(`fake gh: unexpected args ${args.join(" ")}`);
  };

  return {
    prs,
    repos,
    requests,
    mutations,
    fetch,
    runGh,
    failNextMutation(message: string) {
      failNextMutation = message;
    },
    failNextThreadedReview() {
      failNextThreadedReview = true;
    },
  };
}

/** An open PR with passing checks, ready to merge. */
export function fakePr(overrides: Partial<FakePr> = {}): FakePr {
  return {
    title: "Add poller",
    state: "OPEN",
    isDraft: false,
    reviewDecision: "APPROVED",
    mergeable: "MERGEABLE",
    headRefName: "feat/poller",
    baseRefName: "main",
    headRefOid: "head-1",
    updatedAt: "2026-10-01T10:00:00Z",
    autoMergeRequest: null,
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: { nodes: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] },
            },
          },
        },
      ],
    },
    ...overrides,
  };
}
