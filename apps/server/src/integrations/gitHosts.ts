import { GITHUB_HOST } from "@repo/contracts";
import type {
  GitHostDefinition,
  GitHostStatus,
  IssueRef,
  MergeMethod,
  MilestoneRef,
  PrRef,
  TaskLink,
} from "@repo/contracts";
import { AppError } from "../errors.ts";
import {
  GitHostError,
  type EpicMergeInput,
  type EpicPrInput,
  type GitHost,
  type HostIssue,
  type HostMilestone,
  type PostedReview,
  type OpenPrListing,
  type PostedComment,
  type PostReviewInput,
  type PrAgentHints,
  type PrThreadState,
  type RepoPr,
} from "./gitHost.ts";
import type { MergeTaskPrResult } from "./mergeTaskPr.ts";
import type { PrMerges } from "./prMerge.ts";
import { messageOf } from "./util.ts";

/** Every git host kind the board knows, and which one serves a host name. */
export interface GitHosts {
  all(): readonly GitHost[];
  /**
   * The kind serving `host`, on the last status read: the first that claims it by name, else the first whose CLI is
   * signed in to it. Null when none does.
   */
  forHost(host: string): GitHost | null;
  /** forHost, after reading any status not read lately, so a host signed in to since is found. */
  resolve(host: string): Promise<GitHost | null>;
  /** Each kind's last status read. */
  statuses(): GitHostStatus[];
  /** Each kind's status, read again now. */
  checkStatuses(): Promise<GitHostStatus[]>;
  /** Whether an unfinished PR on `host` keeps a Review task from Done (GitHost.holdsTasks of the kind serving it). */
  holdsTasks(host: string): boolean;
  /** The CLI commands an agent fixing the PR runs, in the host's own CLI. */
  agentHints(pr: { host: string; repo: string; number: number }): PrAgentHints;
  start(): void;
  stop(): void;
}

export function createGitHosts(hosts: readonly GitHost[]): GitHosts {
  if (hosts.length === 0) throw new Error("createGitHosts needs at least one host");
  const forHost = (host: string): GitHost | null =>
    hosts.find((h) => h.definition.claimsHost(host)) ?? hosts.find((h) => h.claims(host)) ?? null;
  return {
    all: () => hosts,
    forHost,
    async resolve(host) {
      const named = hosts.find((h) => h.definition.claimsHost(host));
      if (named) return named;
      await Promise.all(hosts.map((h) => h.ensureStatus()));
      return forHost(host);
    },
    statuses: () => hosts.map((h) => h.status()),
    checkStatuses: () => Promise.all(hosts.map((h) => h.checkStatus())),
    holdsTasks: (host) => forHost(host)?.holdsTasks(host) ?? false,
    // A PR no kind claims isn't polled, so it has nothing to fix; the first kind's commands are as good as any.
    agentHints: (pr) => (forHost(pr.host) ?? hosts[0]!).agentHints(pr),
    start() {
      for (const host of hosts) host.start();
    },
    stop() {
      for (const host of hosts) host.stop();
    },
  };
}

/**
 * What an Autopilot action may do on a git host, as the user's signed-in account: post a review, resolve review
 * threads Autopilot answered, merge a task's PR into its epic's integration branch (checkAutopilotMergeTarget), merge
 * a task flagged for auto-merge into the default branch through merge_task_pr's own path (mergeAutoMergeTask: the
 * flag and the gate are checked there, so no automation can merge any other PR into the default branch), and open and
 * describe the epic's draft PR (never merge it). Each call goes to the host the PR or repository is on.
 */
export interface GitHostActions {
  postReview(ref: PrRef, input: PostReviewInput): Promise<PostedReview>;
  /** The PR's head commit now, in full. */
  prHead(ref: PrRef): Promise<string>;
  /** Merges the PR, with the method the repository allows (a merge commit if it can), and says which. */
  mergeIntoEpicBranch(link: TaskLink, input: EpicMergeInput): Promise<{ method: MergeMethod }>;
  /**
   * Merges the one open PR of a task flagged for auto-merge into the default branch, as merge_task_pr does (mergeTaskPr:
   * it refuses, with the reason, a task that isn't flagged or isn't ready), at `expectedHeadOid`. Moves it to Done.
   */
  mergeAutoMergeTask(
    taskId: string,
    input: { expectedHeadOid: string; via: string },
    actor: string,
  ): Promise<MergeTaskPrResult>;
  /** Reads a PR link again now and stores it (after a merge moved its base); never throws. */
  rereadPr(link: TaskLink): Promise<void>;
  ensureEpicPr(input: EpicPrInput): Promise<{ number: number; url: string; created: boolean }>;
  setPrBody(ref: PrRef, body: string): Promise<void>;
  /** The PR's unresolved review threads and newest commits, read now. */
  reviewThreads(ref: PrRef): Promise<PrThreadState>;
  resolveReviewThread(host: string, threadId: string): Promise<void>;
  /** Review PRs' other people's PRs: the repository's open PRs, and one read in full. */
  listOpenPrs(host: string, repo: string): Promise<OpenPrListing[]>;
  readRepoPr(ref: PrRef): Promise<RepoPr>;
  /** Whether nothing the author wrote changed from `base` to `head` (only merges, or a rebase of the same change). */
  unchangedSince(ref: PrRef, base: string, head: string, baseRef: string): Promise<boolean>;
  /** A conversation comment on the PR, posted or edited (the hand-off comment), and a reply on a review thread. */
  postComment(ref: PrRef, body: string): Promise<PostedComment>;
  editComment(host: string, nodeId: string, body: string): Promise<PostedComment>;
  replyOnThread(host: string, threadId: string, body: string): Promise<void>;
  /** The commands an agent fixing the PR runs, in its host's CLI. */
  agentHints(pr: { host: string; repo: string; number: number }): PrAgentHints;
  /** What the host serving `host` is called and which CLI it uses, for prompts and notes. */
  definitionFor(host: string): GitHostDefinition;
}

/** The actions, each sent to the host serving its PR, after checking the CLI is signed in there. */
export function gitHostActions(
  hosts: GitHosts,
  merges: Pick<PrMerges, "mergeIntoEpicBranch">,
  extra: Partial<Pick<GitHostActions, "mergeAutoMergeTask" | "rereadPr">> = {},
): GitHostActions {
  const on = async (host: string): Promise<GitHost> => {
    const found = await hosts.resolve(host);
    if (!found) {
      const kinds = hosts.all().map((h) => h.definition);
      throw new AppError(
        "VALIDATION",
        `${kinds.map((k) => `${k.cli.label} (${k.cli.name})`).join(" or ")} is not signed in to ${host}: run \`${kinds[0]!.cli.loginCommand(host)}\``,
      );
    }
    await found.requireSignedIn(host);
    return found;
  };
  return {
    postReview: async (ref, input) => (await on(ref.host)).postReview(ref, input),
    prHead: async (ref) => (await on(ref.host)).prHead(ref),
    mergeIntoEpicBranch: (link, input) => merges.mergeIntoEpicBranch(link, input),
    mergeAutoMergeTask: extra.mergeAutoMergeTask ?? unavailable,
    rereadPr: extra.rereadPr ?? (() => Promise.resolve()),
    ensureEpicPr: async (input) => (await on(input.host)).ensurePr(input),
    setPrBody: async (ref, body) => (await on(ref.host)).setPrBody(ref, body),
    reviewThreads: async (ref) => (await on(ref.host)).reviewThreads(ref),
    resolveReviewThread: async (host, threadId) => (await on(host)).resolveReviewThread(host, threadId),
    listOpenPrs: async (host, repo) => (await on(host)).listOpenPrs(host, repo),
    readRepoPr: async (ref) => (await on(ref.host)).readRepoPr(ref),
    unchangedSince: async (ref, base, head, baseRef) => (await on(ref.host)).unchangedSince(ref, base, head, baseRef),
    postComment: async (ref, body) => (await on(ref.host)).postComment(ref, body),
    editComment: async (host, nodeId, body) => (await on(host)).editComment(host, nodeId, body),
    replyOnThread: async (host, threadId, body) => (await on(host)).replyOnThread(host, threadId, body),
    agentHints: (pr) => hosts.agentHints(pr),
    definitionFor: (host) => (hosts.forHost(host) ?? hosts.all()[0]!).definition,
  };
}

/** Issue reads for an import, from the host the issue is on, as AppErrors that say which issue failed. */
export function gitHostIssues(hosts: GitHosts): {
  getIssue(ref: IssueRef): Promise<HostIssue>;
  listSubIssues(ref: IssueRef): Promise<string[]>;
  getMilestone(ref: MilestoneRef): Promise<HostMilestone>;
  listMilestoneIssues(ref: MilestoneRef): Promise<string[]>;
} {
  /** The host serving the issue, once its CLI is signed in there: its token is only ever sent to such a host. */
  const on = async (ref: IssueRef | MilestoneRef): Promise<GitHost> => {
    const host = await hosts.resolve(ref.host);
    if (!host) throw new AppError("VALIDATION", `No git host the board knows serves ${ref.host}`);
    await host.requireSignedIn(ref.host);
    return host;
  };
  return {
    async getIssue(ref) {
      const host = await on(ref);
      try {
        return await host.getIssue(ref);
      } catch (error) {
        if (error instanceof GitHostError && error.reason === "missing-tool") {
          throw new AppError("VALIDATION", error.message);
        }
        throw new AppError("VALIDATION", `Could not read ${ref.repo}#${ref.number}: ${messageOf(error)}`);
      }
    },
    async listSubIssues(ref) {
      const host = await on(ref);
      if (!host.capabilities.subIssues) return [];
      try {
        return await host.listSubIssues(ref);
      } catch (error) {
        throw new AppError(
          "VALIDATION",
          `Could not read the sub-issues of ${ref.repo}#${ref.number}: ${messageOf(error)}`,
        );
      }
    },
    async getMilestone(ref) {
      const host = await on(ref);
      if (!host.capabilities.milestones) {
        throw new AppError("VALIDATION", `${host.definition.label} has no milestones to import`);
      }
      try {
        return await host.getMilestone(ref);
      } catch (error) {
        if (error instanceof GitHostError && error.reason === "missing-tool") {
          throw new AppError("VALIDATION", error.message);
        }
        throw new AppError("VALIDATION", `Could not read ${ref.repo} milestone ${ref.number}: ${messageOf(error)}`);
      }
    },
    async listMilestoneIssues(ref) {
      const host = await on(ref);
      try {
        return await host.listMilestoneIssues(ref);
      } catch (error) {
        throw new AppError(
          "VALIDATION",
          `Could not read the issues of ${ref.repo} milestone ${ref.number}: ${messageOf(error)}`,
        );
      }
    },
  };
}

const unavailable = () => Promise.reject(new Error("No git host is available"));

/** No git host until one is configured: every action that needs one fails with a clear reason. */
export const NO_GIT_HOSTS: GitHostActions = {
  postReview: unavailable,
  prHead: unavailable,
  mergeIntoEpicBranch: unavailable,
  mergeAutoMergeTask: unavailable,
  rereadPr: () => Promise.resolve(),
  ensureEpicPr: unavailable,
  setPrBody: unavailable,
  reviewThreads: unavailable,
  resolveReviewThread: unavailable,
  listOpenPrs: unavailable,
  readRepoPr: unavailable,
  unchangedSince: unavailable,
  postComment: unavailable,
  editComment: unavailable,
  replyOnThread: unavailable,
  agentHints: () => {
    throw new Error("No git host is available");
  },
  // Only names things in a prompt; GitHub's name is what every PR had before there were other hosts.
  definitionFor: () => GITHUB_HOST,
};
