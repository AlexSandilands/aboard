import type { GitHostStatus } from "@repo/contracts";
import type { EpicPrInput, GitHost, PostedReview, PostReviewInput, PrAgentHints, PrThreadState } from "./gitHost.ts";
import type { PrRef } from "@repo/contracts";
import { AppError } from "../errors.ts";

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
  ensureEpicPr(input: EpicPrInput): Promise<{ number: number; url: string; created: boolean }>;
  setPrBody(ref: PrRef, body: string): Promise<void>;
  /** The PR's unresolved review threads and newest commits, read now. */
  reviewThreads(ref: PrRef): Promise<PrThreadState>;
  resolveReviewThread(host: string, threadId: string): Promise<void>;
}

/** The actions, each sent to the host serving its PR, after checking the CLI is signed in there. */
export function gitHostActions(hosts: GitHosts): GitHostActions {
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
    ensureEpicPr: async (input) => (await on(input.host)).ensurePr(input),
    setPrBody: async (ref, body) => (await on(ref.host)).setPrBody(ref, body),
    reviewThreads: async (ref) => (await on(ref.host)).reviewThreads(ref),
    resolveReviewThread: async (host, threadId) => (await on(host)).resolveReviewThread(host, threadId),
  };
}
