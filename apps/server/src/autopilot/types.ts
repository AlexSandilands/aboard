import type { AutopilotEngineSettings, AutopilotField, AutopilotRun, ModelTier, PrRef, Project } from "@repo/contracts";
import type { z } from "zod";
import type { PostedReview, PostReviewInput } from "../integrations/github.ts";
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
  /** Projects where the automation is on. Only candidates in these (or board-wide ones while `board` is set) count. */
  projects: ReadonlyArray<ProjectScope<C>>;
  /** The board-level config when the automation is on for the board itself; null otherwise. */
  board: C | null;
}

/** What a runner recorded about an agent action. */
export type RunPatch = Partial<Pick<AutopilotRun, "runner" | "sessionId" | "threadUrl" | "worktreePath" | "costUsd">>;

/** What an action may do on GitHub: post a review as the user's `gh` account. */
export interface GithubActions {
  postReview(ref: PrRef, input: PostReviewInput): Promise<PostedReview>;
}

/** GitHub until one is configured: every action that needs it fails with a clear reason. */
export const NO_GITHUB: GithubActions = {
  postReview: () => Promise.reject(new Error("GitHub isn't available")),
};

export interface ActionContext<C> {
  services: Services;
  /** Starts agent work; only for automations with needsAgent. What it records goes on this run as it happens. */
  runner: { start(request: RunnerRequest): Promise<RunnerResult> };
  github: GithubActions;
  engine: AutopilotEngineSettings;
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
 * dedupes, applies the limits and records runs; the automation only finds work and does it. It must never merge,
 * close or delete tasks, force-push or push to the default branch (docs/decisions/0008-autopilot-engine.md).
 */
export interface Automation<C extends AutomationConfig = AutomationConfig> {
  key: string;
  title: string;
  description: string;
  /** Starts an agent: counts against the concurrency and daily caps and waits out quiet hours. */
  needsAgent: boolean;
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

/** Agent work an automation asks for. Runs on a task: the run's task is the one the agent works on. */
export interface RunnerRequest {
  run: AutopilotRun;
  /** The prompt the agent starts with (or, for a nudge, the message posted). */
  prompt: string;
  /** The task's suggested tier, mapped to a model through the user's tier settings. */
  tier: ModelTier | null;
  /** The automation's config; the runner reads its RunnerOptions fields (runner choice, budget, timeout, access). */
  options: AutomationConfig;
  /** `start` (default) begins a new session; `nudge` posts the prompt into the task's live T3 thread. */
  kind?: "start" | "nudge";
  /**
   * Where a new session works. A new branch from `baseRef` (default: the default branch), or one based on an
   * existing `branch` that the agent pushes to, e.g. a pull request's. Never the default branch.
   */
  workspace?: { baseRef?: string | null; branch?: string | null };
  /** Headless only: `read-only` can't edit files (a reviewer). Defaults to edit. */
  access?: AgentAccess;
  /** Headless only: tools allowed on top of the access's list, e.g. `Bash(gh pr review *)`. */
  tools?: readonly string[];
  /** Headless only: a JSON schema the agent's answer must match, returned as `output`. */
  outputSchema?: object | null;
  /** Headless read-only only: `false` keeps the agent from the board's tools and every other MCP server. Default true. */
  boardTools?: boolean;
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
