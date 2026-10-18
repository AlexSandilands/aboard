import type {
  AutopilotEngineSettings,
  AutopilotField,
  AutopilotRun,
  ModelTier,
  PrRef,
  Project,
  TaskLink,
} from "@repo/contracts";
import type { z } from "zod";
import type { EpicMergeInput, EpicPrInput, PostedReview, PostReviewInput } from "../integrations/github.ts";
import type { AgentAccess } from "../integrations/headlessAgent.ts";
import type { Services } from "../services/types.ts";

/** Config values keyed by field. */
export type AutomationConfig = Record<string, unknown>;

/** Something an automation wants to do. The engine records it as a run unless its dedupe key already has one. */
export interface Candidate {
  /** Changes exactly when the automation should act again, e.g. `review:pr:<headSha>`. */
  dedupeKey: string;
  /** What the action will do, as a phrase that reads after "Would" ("archive #42"): the run's summary, prefixed in dry-run. */
  summary: string;
  taskId?: string | null;
  /** Only for candidates with no task (a task's project is used); null is a board-wide candidate. */
  projectId?: string | null;
  /** Anything the check found that the action needs. */
  data?: unknown;
  /** What the action would run (a filled prompt, a command): kept on a dry run's record. */
  preview?: string;
}

/** One project where the automation is on, with its effective config there. */
export interface ProjectScope<C> {
  project: Project;
  config: C;
}

export interface CheckContext<C> {
  services: Services;
  engine: AutopilotEngineSettings;
  now: Date;
  /**
   * Projects where the automation is on, or has an epic it is on for (then the check sees the whole project, and the
   * engine drops the tasks the epic's setting doesn't reach). `config` is the project's. Only candidates in these (or
   * board-wide ones while `board` is set) count.
   */
  projects: ReadonlyArray<ProjectScope<C>>;
  /** The board-level config when the automation is on for the board itself; null otherwise. */
  board: C | null;
}

/** What a runner recorded about an agent action. */
export type RunPatch = Partial<
  Pick<AutopilotRun, "runner" | "sessionId" | "threadUrl" | "worktreePath" | "costUsd" | "detail" | "exitCode">
>;

/**
 * What an action may do on GitHub, as the user's `gh` account: post a review, merge a task's PR into its epic's
 * integration branch (never into the default branch: checkAutopilotMergeTarget), and open and describe the epic's
 * draft PR (never merge it).
 */
export interface GithubActions {
  postReview(ref: PrRef, input: PostReviewInput): Promise<PostedReview>;
  /** The PR's head commit on GitHub now, in full. */
  prHead(ref: PrRef): Promise<string>;
  mergeIntoEpicBranch(link: TaskLink, input: EpicMergeInput): Promise<void>;
  ensureEpicPr(input: EpicPrInput): Promise<{ number: number; url: string; created: boolean }>;
  setPrBody(ref: PrRef, body: string): Promise<void>;
}

const noGithub = () => Promise.reject(new Error("GitHub isn't available"));

/** GitHub until one is configured: every action that needs it fails with a clear reason. */
export const NO_GITHUB: GithubActions = {
  postReview: noGithub,
  prHead: noGithub,
  mergeIntoEpicBranch: noGithub,
  ensureEpicPr: noGithub,
  setPrBody: noGithub,
};

export interface ActionContext<C> {
  services: Services;
  /** Starts agent work; only for automations with needsAgent. What it records goes on this run as it happens. */
  runner: { start(request: RunnerRequest): Promise<RunnerResult> };
  github: GithubActions;
  engine: AutopilotEngineSettings;
  /** Where the user opens the board, e.g. `http://127.0.0.1:5317`, for prompts that point an agent at a task. */
  boardUrl: string;
  /** The effective config for the candidate's project (or the board's). */
  config: C;
  run: AutopilotRun;
  /** The actor for any change the action makes. */
  actor: string;
  /** Records runner details on the run while the action is still going. */
  update(patch: RunPatch): void;
}

export interface ActionResult extends RunPatch {
  /** Defaults to succeeded. */
  status?: "succeeded" | "failed" | "skipped";
  /** Replaces the run's summary with what actually happened. */
  summary?: string;
  error?: string;
  /** Show the run's error (or summary) on the task under Needs attention. */
  needsAttention?: boolean;
  /** Kept on the run for later automations to read, e.g. the verdict of a review. */
  output?: Record<string, unknown>;
}

/**
 * One automation: a deterministic check over board state and an action per candidate. The engine resolves scopes,
 * dedupes, applies the limits and records runs; the automation only finds work and does it. It must never merge into
 * the default branch, close or delete tasks, force-push or push to the default branch; the one merge it may make is a
 * task's PR into its epic's integration branch (docs/decisions/0008-autopilot-engine.md).
 */
export interface Automation<C extends AutomationConfig = AutomationConfig> {
  key: string;
  title: string;
  description: string;
  /** Starts an agent: counts against the concurrency and daily caps and waits out quiet hours. */
  needsAgent: boolean;
  /**
   * The action can take long (a shell command, or waiting on an agent) without being an agent run for the caps, so
   * the engine doesn't hold up the rest of its pass for it. At most AUTOPILOT_BACKGROUND_MAX of these that aren't
   * agent runs go at once. Agent automations are always like this.
   */
  background?: boolean;
  /**
   * Whether an epic can switch it on or off for its tasks (default true). Set false when its candidates are never
   * tasks in an epic: the epic's popover then leaves it out, the epic button ignores it, and the service refuses an
   * epic-scope setting for it.
   */
  epicScope?: boolean;
  /** Parses the merged config; it should give every field a default. */
  schema: z.ZodType<C>;
  /** How the UI renders the config form. */
  fields: AutopilotField[];
  defaults: C;
  check(ctx: CheckContext<C>): Candidate[] | Promise<Candidate[]>;
  act(candidate: Candidate, ctx: ActionContext<C>): ActionResult | Promise<ActionResult>;
}

/** Keeps an automation's config type while letting registries hold automations with different ones. */
export const defineAutomation = <C extends AutomationConfig>(automation: Automation<C>): Automation => automation;

/**
 * Agent work an automation asks for. Normally on a task: the run's task is the one the agent works on. A run with no
 * task (a digest) is headless only, in an empty folder of its own, with no worktree, no session link and no nudge.
 */
export interface RunnerRequest {
  run: AutopilotRun;
  /** The prompt the agent starts with (or, for a nudge, the message posted). */
  prompt: string;
  /**
   * What the run is, short, for the session's name: "Review PRs · PR #73 round 1". The runner prefixes it with
   * "Autopilot · " and uses it as the session link's label, the `claude --name` and the T3 thread's title.
   */
  label?: string;
  /** The task's suggested tier, mapped to a model through the user's tier settings. */
  tier: ModelTier | null;
  /** The automation's config; the runner reads its RunnerOptions fields (runner choice, budget, timeout, access). */
  options: AutomationConfig;
  /** `start` (default) begins a new session; `nudge` posts the prompt into the task's live T3 thread. */
  kind?: "start" | "nudge";
  /**
   * Where a new session works. A new branch from `baseRef` (default: the default branch), or one based on an
   * existing `branch` that the agent pushes to, e.g. a pull request's. Never the default branch. `prBase` is the branch
   * the agent's pull request goes to when that isn't the default branch (an integration epic's): the session starts
   * from origin's copy of it, and the workspace note says to open the pull request against it.
   */
  workspace?: { baseRef?: string | null; branch?: string | null; prBase?: string | null };
  /**
   * A task-less headless run only (it has no worktree): the project's checkout, whose default branch the run is told
   * not to push to and is denied pushing to. The run itself works in an empty temporary folder, never here. Null (a
   * project with no folder) still gets the safety note, without a branch name; leaving it out adds neither.
   */
  repo?: string | null;
  /** Headless only: `read-only` can't edit files (a reviewer); `none` has no tools at all. Defaults to edit. */
  access?: AgentAccess;
  /** Headless only: tools allowed on top of the access's list, e.g. `Bash(gh pr review *)`. */
  tools?: readonly string[];
  /** Headless only: a JSON schema the agent's answer must match, returned as `output`. */
  outputSchema?: object | null;
  /**
   * Headless read-only only: the agent reads text anyone can write (a PR's description and comments). It gets no
   * board tools, no MCP servers and no files outside its worktree.
   */
  untrustedInput?: boolean;
  /**
   * Headless only: the commit the worktree must be at, checked before the agent starts. A worktree at another commit
   * throws `WorktreeHeadError`.
   */
  expectHead?: string;
  /**
   * T3 only: asked before each retry while the runner waits for T3 Code to come up. False when the work is no longer
   * wanted (the task moved on meanwhile), which ends the wait with a RunAbandonedError.
   */
  stillWanted?: () => boolean;
}

/** The runner stopped waiting because the request is no longer wanted (`stillWanted` said no). Not a failure. */
export class RunAbandonedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunAbandonedError";
  }
}

/** The worktree isn't at the commit `expectHead` named. `moved` is true when it is ahead of it: the branch moved on. */
export class WorktreeHeadError extends Error {
  constructor(
    message: string,
    readonly head: string,
    readonly moved: boolean,
  ) {
    super(message);
    this.name = "WorktreeHeadError";
  }
}

/** What a runner did. A T3 run returns once the thread is started; a headless run once the agent finished. */
export interface RunnerResult extends RunPatch {
  /** The headless agent's final message; null for T3 runs. */
  result: string | null;
  /** The structured output, when an output schema was asked for. */
  output?: unknown;
}

/**
 * Carries out agent work for automations: a T3 Code thread, a nudge into one, or `claude -p` in a worktree.
 * `update` records the session, thread or worktree on the run as soon as they exist, so a run that fails later
 * still shows them. Throws when the work couldn't be done; the run then fails with the error.
 */
export interface Runner {
  start(request: RunnerRequest, update?: (patch: RunPatch) => void): Promise<RunnerResult>;
}

/** The runner until one is configured: every agent action fails with a clear reason. */
export const NO_RUNNER: Runner = {
  start: () => Promise.reject(new Error("No agent runner is available yet")),
};
