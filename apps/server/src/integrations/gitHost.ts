import type {
  GitHostDefinition,
  GitHostKind,
  GitHostStatus,
  IssueRef,
  MergeMethod,
  MergePrInput,
  PrMergeState,
  PrRef,
  PrReviewThreadInfo,
  PrSnapshot,
} from "@repo/contracts";
import { AppError } from "../errors.ts";

// Everything the board does on a git host, behind one interface so another host (GitLab, Bitbucket, Gitea) can plug in
// without touching the poller, merges, Autopilot, prompts or the run tools (docs/decisions/0014-git-hosts.md). GitHub
// is the only implementation (githubHost.ts); the GitHosts registry (gitHosts.ts) picks the host for a PR or issue.

// ── Errors ───────────────────────────────────────────────────────────────

export type GitHostErrorReason =
  /** The host's CLI isn't installed. */
  | "missing-tool"
  /** The CLI holds no login for the host, or the host refused it. */
  | "unauthenticated"
  | "rate-limited"
  | "not-found"
  /** The request never got an answer (network, timeout): another try may get through. */
  | "transient"
  /** The host answered with a failure. */
  | "failed";

/** A git host's failure. Its message is safe to show and to give an agent: the host's own words, never a credential. */
export class GitHostError extends Error {
  constructor(
    readonly reason: GitHostErrorReason,
    readonly host: string,
    message: string,
  ) {
    super(message);
    this.name = "GitHostError";
  }
}

/**
 * Failures another try may get past: the host itself failing ("an internal error occurred, please try again", `HTTP
 * 5xx`), the network, a timeout, a rate limit. Anything else (a refusal, a missing PR) won't change.
 */
const TRANSIENT_FAILURE =
  /try again|internal error|timed? ?out|econn|fetch failed|socket|rate limit|unavailable|\bHTTP 5\d\d\b/i;

export function isTransientHostError(error: unknown): boolean {
  if (error instanceof GitHostError && (error.reason === "transient" || error.reason === "rate-limited")) return true;
  return TRANSIENT_FAILURE.test(error instanceof Error ? error.message : String(error));
}

/** Whether a failure is the host as a whole refusing (signed out, rate-limited, unreachable), not one PR. */
export const isHostWideError = (error: unknown): boolean =>
  error instanceof GitHostError && error.reason !== "not-found" && error.reason !== "failed";

// ── Reads ────────────────────────────────────────────────────────────────

export interface HostPr {
  number: number;
  url: string;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  author: string | null;
  baseRef: string;
  headRef: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface HostPrFile {
  path: string;
  /** The path before a rename or copy. */
  previousPath: string | null;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  /** The file's unified diff hunks, or null when the host serves none (a binary file, or one too large). */
  patch: string | null;
}

/** A conversation comment, a review's own body, or an inline comment on the diff. */
export interface HostComment {
  id: number;
  kind: "conversation" | "review" | "inline";
  author: string | null;
  body: string;
  createdAt: string;
  url: string | null;
  /** A review's state (COMMENTED, APPROVED, CHANGES_REQUESTED, …). */
  state?: string | null;
  /** An inline comment's place in the diff. */
  path?: string | null;
  line?: number | null;
  inReplyTo?: number | null;
  /** The review an inline comment belongs to. */
  reviewId?: number | null;
}

export interface HostIssue {
  number: number;
  url: string;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  author: string | null;
}

/** One page of text: its number from 1, how many there are, and the text itself. */
export interface TextPage {
  page: number;
  pages: number;
  text: string;
}

export interface DiffPage extends TextPage {
  /** The file the pages walk, or null for the whole pull request. */
  path: string | null;
}

/** What headless runs read (run tools). Every method throws on failure with a message safe to show an agent. */
export interface GitHostReads {
  getPr(ref: PrRef): Promise<HostPr>;
  /** Every changed file of the PR, with its patch. */
  listFiles(ref: PrRef): Promise<HostPrFile[]>;
  /** One page of the PR's diff: of one file when `path` is given, else of every file in order. Pages count from 1. */
  getDiff(ref: PrRef, path: string | null, page: number): Promise<DiffPage>;
  /** The PR's conversation comments, review bodies and inline comments, oldest first. */
  getComments(ref: PrRef): Promise<HostComment[]>;
  getIssue(ref: IssueRef): Promise<HostIssue>;
}

// ── Other people's PRs ───────────────────────────────────────────────────

/** An open PR as listed, before its detail is read: enough to choose which to read. */
export interface OpenPrListing {
  number: number;
  author: string | null;
  draft: boolean;
}

/** A comment's or review's author and text, as Review PRs reads another person's PR (logins lower-cased). */
interface RepoPrPost {
  author: string | null;
  body: string;
}

/**
 * Another person's open PR, read in full for Review PRs (docs/features/autopilot.md#other-peoples-prs): its history,
 * threads and checks, which the review's mode and approval gate are worked out from. Logins are lower-cased. Reads
 * the host's newest 100 of each list; `files.total` says when there were more files than read.
 */
export interface RepoPr {
  number: number;
  url: string;
  title: string;
  author: string | null;
  draft: boolean;
  state: "open" | "closed" | "merged";
  headOid: string;
  headRef: string;
  baseRef: string;
  isCrossRepository: boolean;
  /** The signed-in account, which Autopilot posts as. */
  viewer: string;
  /** Issues the PR closes (`Closes #n`). */
  closingIssues: number[];
  /** Open issues in the same repository that mention the PR: often a bug report against it. */
  referencingIssues: number[];
  files: { total: number; paths: string[] };
  /** The newest 100 commits, oldest first. */
  commits: Array<{ oid: string; committedDate: string; parents: number }>;
  /**
   * The head commit's checks, each judged by its newest run, counting only the required ones when the base branch
   * requires any. `missing` are required checks that haven't reported at all; `latestAt` is when the last one finished.
   */
  checks: { pending: string[]; failing: string[]; missing: string[]; latestAt: string | null };
  /** Each reviewer's latest review that counts (GitHub's `latestReviews`). */
  latestReviews: Array<RepoPrPost & { state: string }>;
  /** Submitted reviews, oldest first. */
  reviews: Array<
    RepoPrPost & { id: number | null; state: string; submittedAt: string | null; commitOid: string | null }
  >;
  /** Conversation comments, oldest first. `nodeId` is what an edit names. */
  comments: Array<RepoPrPost & { id: number; nodeId: string; url: string; createdAt: string; editedAt: string | null }>;
  threads: Array<{
    id: string;
    resolved: boolean;
    canResolve: boolean;
    comments: Array<RepoPrPost & { id: number; createdAt: string; path: string | null; line: number | null }>;
  }>;
  /** Approvals or requests for changes someone dismissed, oldest first. */
  dismissals: Array<{
    createdAt: string;
    actor: string | null;
    previousState: string;
    review: (RepoPrPost & { submittedAt: string | null; commitOid: string | null }) | null;
  }>;
}

/** A conversation comment Autopilot posted or edited. */
export interface PostedComment {
  id: number;
  nodeId: string;
  url: string;
}

// ── Writes and merges ────────────────────────────────────────────────────

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
  /**
   * A comment (the default), or an approval or request for changes. Only Review PRs' other-people's-PRs source asks
   * for the last two, after the board's own approval gate passed; task PRs are only ever commented on.
   */
  event?: "comment" | "approve" | "request_changes";
}

export interface PostedReview {
  id: number | null;
  url: string;
  /** The PR's head commit the review was posted against, in full. */
  headOid: string;
  /** Inline comments the host refused (a line outside the diff) and that went into the body instead. */
  folded: number;
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

/** A PR's review threads as the host has them now. */
export interface PrThreadState {
  headOid: string;
  /** The PR's newest 100 commits, in full. */
  commits: string[];
  /** Its unresolved threads. */
  threads: ReviewThreadDetail[];
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
  /** The base the board's snapshot shows; it must be the default branch, and still the PR's base on the host. */
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

/** A PR as the host has it just before a board-made merge, so the merge guard checks what is true now. */
export interface MergeTarget {
  /** The host's own id for the PR, handed back to `mergeAt`. */
  id: string;
  state: "open" | "closed" | "merged";
  headOid: string;
  base: string;
  /** The repository's default branch, or null when the host won't say. */
  defaultBranch: string | null;
  /** Whether the host would merge it now; undefined when it can't tell yet. */
  mergeState: PrMergeState | undefined;
  /** The merge methods the repository's settings allow now. */
  mergeMethods: MergeMethod[];
}

/** The commands an agent fixing a PR runs to read it and reply on it, in the host's own CLI. */
export interface PrAgentHints {
  /** Lists the PR's checks. */
  checks: string;
  /** Reads a failed check run's log; `<run id>` is left for the agent. */
  runLog: string;
  /** Reads the PR's base branch. */
  baseBranch: string;
  /** Reads the PR's conversation and review bodies. */
  conversation: string;
  /** Reads every inline review comment. */
  inlineComments: string;
  /** Reads one review's summary. */
  review(reviewId: number): string;
  /** Reads one review's inline comments. */
  reviewComments(reviewId: number): string;
  /** Reads one inline comment; `<comment id>` is left for the agent. */
  comment: string;
  /** Posts the reply written to `file` on a review thread; `<comment id>` is left for the agent. */
  reply(file: string): string;
}

/** What a host can do, so a caller says so up front instead of failing halfway. */
export interface GitHostCapabilities {
  /** Merging when the PR is ready, or through a merge queue. */
  autoMerge: boolean;
  /** Review threads that can be read and resolved one by one. */
  reviewThreads: boolean;
  /** Issues with sub-issues, which an import turns into tasks. */
  subIssues: boolean;
  /** Making a private repository for the backup. */
  createRepo: boolean;
}

/**
 * One git host kind, signed in with its CLI: the reads headless runs make, the poll, merges and the writes Autopilot
 * makes. A method for a host the CLI isn't signed in to throws an AppError saying how to sign in. Failures are
 * GitHostError (or AppError), with messages safe to show.
 */
export interface GitHost extends GitHostReads {
  readonly kind: GitHostKind;
  readonly definition: GitHostDefinition;
  readonly capabilities: GitHostCapabilities;

  /** The last status read; the first call starts a check. */
  status(): GitHostStatus;
  /** Re-detects the CLI and its per-host sign-in. */
  checkStatus(): Promise<GitHostStatus>;
  /** The status, read again when it is older than the re-check interval. */
  ensureStatus(): Promise<GitHostStatus>;
  /** Whether `host` is this kind's: claimed by name, or one the CLI is signed in to (on the last status read). */
  claims(host: string): boolean;
  /** Whether the CLI is signed in to `host`, so requests may go there (on the last status read). */
  reaches(host: string): boolean;
  /** Throws an AppError saying how to sign in, unless the CLI is installed and signed in to `host`. */
  requireSignedIn(host: string): Promise<void>;
  /**
   * Whether an unfinished PR on the host keeps a Review task from Done. github.com always does, so not knowing yet
   * whether gh works can't let one merge finish a task whose other PR is open. Other hosts only while they're polled.
   */
  holdsTasks(host: string): boolean;

  /**
   * Many PRs of one repository, in one go where the host allows it: one entry per number, in order, a snapshot or why
   * that PR couldn't be read. Throws GitHostError when the whole read failed; `isHostWideError` tells a host that
   * refused (stop asking it this poll) from one repository's failure.
   *
   * Checks: each check is judged by its newest run, as GitHub's merge box does. A run a newer one replaced (a cancelled
   * run, a re-run, a push re-triggering it) must not count, or a PR shows failing checks it no longer has. Only the
   * checks the base branch requires decide `checks` when any is required; the rest go to `optionalChecks`.
   */
  readSnapshots(host: string, repo: string, numbers: readonly number[]): Promise<Array<PrSnapshot | { error: string }>>;
  /** One PR, read now. Throws on any failure. */
  readSnapshot(ref: PrRef): Promise<PrSnapshot>;

  /**
   * The panel's merge, auto-merge and turning auto-merge off, after the board's own checks passed. Refuses with a
   * CONFLICT when the head moved past `expectedHeadOid`. Throws on the host's refusal.
   */
  merge(ref: PrRef, input: MergePrInput & { expectedHeadOid: string | null }): Promise<void>;
  /** The PR as the host has it now, read just before a board-made merge. */
  mergeTarget(ref: PrRef): Promise<MergeTarget>;
  /**
   * Merges at the target's head with the first of `methods` the host accepts, moving on only when it refuses a method
   * as not allowed. Returns the method that merged; throws the last refusal.
   */
  mergeAt(ref: PrRef, target: MergeTarget, methods: readonly MergeMethod[]): Promise<MergeMethod>;
  /** The PR's head commit now, in full. Throws AppError. */
  prHead(ref: PrRef): Promise<string>;
  /**
   * Posts one review as the signed-in account: a comment unless `input.event` says otherwise (only Review PRs' other
   * people's PRs, after the board's approval gate passed, approve or request changes).
   * Throws StaleReviewError when the head isn't the commit read, GitHostError (with its reason) for the host's refusal.
   */
  postReview(ref: PrRef, input: PostReviewInput): Promise<PostedReview>;
  /** The PR's unresolved review threads and newest commits, read now. Throws AppError. */
  reviewThreads(ref: PrRef): Promise<PrThreadState>;
  /** The repository's open PRs (the newest 100 by update), for Review PRs' other-people's-PRs source. */
  listOpenPrs(host: string, repo: string): Promise<OpenPrListing[]>;
  /** One PR in full: history, threads, checks. */
  readRepoPr(ref: PrRef): Promise<RepoPr>;
  /**
   * Whether nothing the author wrote changed from `base` to `head`: only merges came in, or a rebase left the same
   * change against `baseRef`.
   */
  unchangedSince(ref: PrRef, base: string, head: string, baseRef: string): Promise<boolean>;
  /** Posts a conversation comment on the PR as the signed-in account. */
  postComment(ref: PrRef, body: string): Promise<PostedComment>;
  /** Replaces the text of a conversation comment the signed-in account posted. */
  editComment(host: string, nodeId: string, body: string): Promise<PostedComment>;
  /** Replies on a review thread as the signed-in account. */
  replyOnThread(host: string, threadId: string, body: string): Promise<void>;
  /** Resolves one review thread as the signed-in account. Throws AppError. */
  resolveReviewThread(host: string, threadId: string): Promise<void>;
  /** The open PR from `head` into the default branch, opened as a draft when there is none. Never merged. */
  ensurePr(input: EpicPrInput): Promise<{ number: number; url: string; created: boolean }>;
  /** Replaces a PR's description. Throws AppError. */
  setPrBody(ref: PrRef, body: string): Promise<void>;
  /** The URLs of an issue's sub-issues, in the host's order; none for an issue without any. */
  listSubIssues(ref: IssueRef): Promise<string[]>;
  /**
   * Makes a private repository under the signed-in account on the kind's main host, for the backup. `webUrl` is its
   * page, `pushUrl` what git pushes to, over the protocol the CLI tells git to use.
   */
  createRepo(name: string, opts: { description: string }): Promise<{ webUrl: string; pushUrl: string }>;
  /** The CLI commands an agent fixing the PR runs. Pure. */
  agentHints(pr: { host: string; repo: string; number: number }): PrAgentHints;

  /** Starts re-checking the status on a timer. */
  start(): void;
  stop(): void;
}

// ── Paging ───────────────────────────────────────────────────────────────

/**
 * How much text one page holds: whichever limit is hit first. Small enough that every CLI shows a tool result whole
 * (Codex cuts long tool output short), so a large diff takes more pages, never a cut-off one.
 */
export interface PageLimits {
  lines: number;
  chars: number;
}

export const PAGE_LIMITS: PageLimits = { lines: 400, chars: 20_000 };

/** A line longer than a whole page (minified code, a lockfile) is cut here, with a marker saying so. */
const cutLine = (line: string, chars: number): string => {
  const max = Math.max(200, Math.floor(chars / 2));
  return line.length > max ? `${line.slice(0, max)} … [line cut at ${max} of ${line.length} characters]` : line;
};

/**
 * Packs blocks of lines into pages. A block that doesn't fit what is left of a page starts a new one; a block longer
 * than a page is split across pages, each continuation opening with the block's `continued` line so a page read alone
 * still says what it shows.
 */
export function packPages(
  blocks: ReadonlyArray<{ lines: readonly string[]; continued?: string }>,
  limits: PageLimits = PAGE_LIMITS,
): string[] {
  const pages: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  const close = () => {
    if (current.length > 0) pages.push(current);
    current = [];
    chars = 0;
  };
  const fits = (line: string) => current.length < limits.lines && chars + line.length + 1 <= limits.chars;
  for (const block of blocks) {
    const lines = block.lines.map((l) => cutLine(l, limits.chars));
    const size = lines.reduce((n, l) => n + l.length + 1, 0);
    // A block that would fit a page of its own isn't split across two.
    if (current.length > 0 && (current.length + lines.length > limits.lines || chars + size > limits.chars)) {
      if (lines.length <= limits.lines && size <= limits.chars) close();
    }
    lines.forEach((line, i) => {
      if (!fits(line)) {
        close();
        if (i > 0 && block.continued) {
          const head = cutLine(block.continued, limits.chars);
          current.push(head);
          chars += head.length + 1;
        }
      }
      current.push(line);
      chars += line.length + 1;
    });
  }
  close();
  return pages.map((p) => p.join("\n"));
}

/** Picks one page, refusing one out of range with how many there are. */
export function pickPage(pages: readonly string[], page: number, what: string): TextPage {
  const count = Math.max(1, pages.length);
  if (!Number.isInteger(page) || page < 1 || page > count) {
    throw new AppError("VALIDATION", `${what} has ${count} page${count === 1 ? "" : "s"}; page ${page} doesn't exist`);
  }
  return { page, pages: count, text: pages[page - 1] ?? "" };
}

const fileHeader = (f: HostPrFile) =>
  `diff --git a/${f.previousPath ?? f.path} b/${f.path} (${f.status}, +${f.additions} -${f.deletions})`;

/** The lines one file contributes to the diff: its header, then its patch, or why there is none. */
function fileBlock(f: HostPrFile): { lines: string[]; continued: string } {
  const header = fileHeader(f);
  const body =
    f.patch === null
      ? ["(No diff served for this file: it is binary or too large. Read it in your checkout if you need it.)"]
      : f.patch.split(/\r?\n/);
  return { lines: [header, ...body, ""], continued: `${header} (continued)` };
}

/** The pages of a PR's diff, or of one of its files. Throws when `path` isn't a changed file. */
export function diffPages(
  files: readonly HostPrFile[],
  path: string | null,
  limits: PageLimits = PAGE_LIMITS,
): string[] {
  if (path === null) return packPages(files.map(fileBlock), limits);
  const file = files.find((f) => f.path === path) ?? files.find((f) => f.previousPath === path);
  if (!file) throw new AppError("NOT_FOUND", `${path} isn't changed in this pull request`);
  return packPages([fileBlock(file)], limits);
}

/** One page of a PR's diff, as GitHost.getDiff returns it. */
export function pageDiff(
  files: readonly HostPrFile[],
  path: string | null,
  page: number,
  limits: PageLimits = PAGE_LIMITS,
): DiffPage {
  const picked = pickPage(diffPages(files, path, limits), page, path === null ? "The diff" : `The diff of ${path}`);
  return { ...picked, path };
}
