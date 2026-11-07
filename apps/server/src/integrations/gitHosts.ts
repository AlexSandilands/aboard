import { GITHUB_HOST } from "@repo/contracts";
import type { GitHostDefinition, GitHostStatus, IssueRef, MergeMethod, PrRef, TaskLink } from "@repo/contracts";
import { AppError } from "../errors.ts";
import {
  GitHostError,
  type EpicMergeInput,
  type EpicPrInput,
  type GitHost,
  type HostIssue,
  type PostedReview,
  type PostReviewInput,
  type PrAgentHints,
  type PrThreadState,
} from "./gitHost.ts";
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
 * threads Autopilot answered, merge a task's PR into its epic's integration branch (never into the default branch:
 * checkAutopilotMergeTarget), and open and describe the epic's draft PR (never merge it). Each call goes to the host
 * the PR or repository is on.
 */
export interface GitHostActions {
  postReview(ref: PrRef, input: PostReviewInput): Promise<PostedReview>;
  /** The PR's head commit now, in full. */
  prHead(ref: PrRef): Promise<string>;
  /** Merges the PR, with the method the repository allows (a merge commit if it can), and says which. */
  mergeIntoEpicBranch(link: TaskLink, input: EpicMergeInput): Promise<{ method: MergeMethod }>;
  ensureEpicPr(input: EpicPrInput): Promise<{ number: number; url: string; created: boolean }>;
  setPrBody(ref: PrRef, body: string): Promise<void>;
  /** The PR's unresolved review threads and newest commits, read now. */
  reviewThreads(ref: PrRef): Promise<PrThreadState>;
  resolveReviewThread(host: string, threadId: string): Promise<void>;
  /** The commands an agent fixing the PR runs, in its host's CLI. */
  agentHints(pr: { host: string; repo: string; number: number }): PrAgentHints;
  /** What the host serving `host` is called and which CLI it uses, for prompts and notes. */
  definitionFor(host: string): GitHostDefinition;
}

/** The actions, each sent to the host serving its PR, after checking the CLI is signed in there. */
export function gitHostActions(hosts: GitHosts, merges: Pick<PrMerges, "mergeIntoEpicBranch">): GitHostActions {
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
    ensureEpicPr: async (input) => (await on(input.host)).ensurePr(input),
    setPrBody: async (ref, body) => (await on(ref.host)).setPrBody(ref, body),
    reviewThreads: async (ref) => (await on(ref.host)).reviewThreads(ref),
    resolveReviewThread: async (host, threadId) => (await on(host)).resolveReviewThread(host, threadId),
    agentHints: (pr) => hosts.agentHints(pr),
    definitionFor: (host) => (hosts.forHost(host) ?? hosts.all()[0]!).definition,
  };
}

/** Issue reads for an import, from the host the issue is on, as AppErrors that say which issue failed. */
export function gitHostIssues(hosts: GitHosts): {
  getIssue(ref: IssueRef): Promise<HostIssue>;
  listSubIssues(ref: IssueRef): Promise<string[]>;
} {
  const on = async (ref: IssueRef): Promise<GitHost> => {
    const host = await hosts.resolve(ref.host);
    if (!host) throw new AppError("VALIDATION", `No git host the board knows serves ${ref.host}`);
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
  };
}

const unavailable = () => Promise.reject(new Error("No git host is available"));

/** No git host until one is configured: every action that needs one fails with a clear reason. */
export const NO_GIT_HOSTS: GitHostActions = {
  postReview: unavailable,
  prHead: unavailable,
  mergeIntoEpicBranch: unavailable,
  ensureEpicPr: unavailable,
  setPrBody: unavailable,
  reviewThreads: unavailable,
  resolveReviewThread: unavailable,
  agentHints: () => {
    throw new Error("No git host is available");
  },
  // Only names things in a prompt; GitHub's name is what every PR had before there were other hosts.
  definitionFor: () => GITHUB_HOST,
};
