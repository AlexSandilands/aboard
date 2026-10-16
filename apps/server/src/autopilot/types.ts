import type { AutopilotEngineSettings, AutopilotField, AutopilotRun, ModelTier, Project } from "@repo/contracts";
import type { z } from "zod";
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
export type RunPatch = Partial<Pick<AutopilotRun, "runner" | "sessionId" | "threadUrl" | "worktreePath" | "costUsd">>;

export interface ActionContext<C> {
  services: Services;
  /** Starts agent work; only for automations with needsAgent. */
  runner: Runner;
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

/** Agent work an automation asks for. */
export interface RunnerRequest {
  run: AutopilotRun;
  /** The prompt the agent starts with. */
  prompt: string;
  /** The task's suggested tier, mapped to a model through the user's tier settings. */
  tier: ModelTier | null;
  /** The automation's runner options (runner choice, budget, timeout, T3 access), as its config holds them. */
  options: AutomationConfig;
}

/**
 * Carries out agent work for automations: a T3 Code thread, or `claude -p` in a worktree. Resolves once the agent
 * has been started (or, for headless runs, has finished), with what it recorded.
 */
export interface Runner {
  start(request: RunnerRequest): Promise<RunPatch>;
}

/** The runner until one is configured: every agent action fails with a clear reason. */
export const NO_RUNNER: Runner = {
  start: () => Promise.reject(new Error("No agent runner is available yet")),
};
