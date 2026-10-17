import { z } from "zod";
import { AgentHarness, AGENT_HARNESSES } from "./agentSessions.ts";
import { BRAND } from "./brand.ts";
import type { ModelTier, ModelTiers } from "./modelTiers.ts";

// Starting a new Claude Code or Copilot CLI session on a task from the board: the CLI opens in a terminal with the
// hand-off prompt, in a new worktree or the project's checkout. See docs/features/agent-sessions.md.

/**
 * A model as `--model` takes it: an alias ("opus"), an id ("claude-opus-5-5[1m]") or a provider's slug. It goes on a
 * command line, so only characters no shell reads anything into.
 */
export const CliModel = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[\w.:@/[\]-]+$/, "letters, digits and . : @ / [ ] - only");

/** Whether the board can start a harness's CLI here: the configured path, else the CLI on PATH. */
export const AgentCliStatus = z.object({
  harness: AgentHarness,
  available: z.boolean(),
  /** The executable found, when it was. */
  path: z.string().nullable(),
});
export type AgentCliStatus = z.infer<typeof AgentCliStatus>;

/** `GET /api/agent-clis`: one entry per harness. */
export const AgentClis = z.array(AgentCliStatus);
export type AgentClis = z.infer<typeof AgentClis>;

/**
 * Where a new session runs: a new worktree branched from `baseRef`, a new worktree on a pull request's own `branch`
 * (origin's copy; the session pushes back to it), or the project's own checkout.
 */
export const SessionWorkspace = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("current") }),
  z.object({ mode: z.literal("new_worktree"), baseRef: z.string().trim().min(1) }),
  z.object({ mode: z.literal("pr_branch"), branch: z.string().trim().min(1) }),
]);
export type SessionWorkspace = z.infer<typeof SessionWorkspace>;

/** `GET /api/tasks/:id/session-launch-options`: what the launch dialog offers for a task. */
export const SessionLaunchOptions = z.object({
  clis: AgentClis,
  /** The project's folder, where "This checkout" runs. Null when the project has none. */
  workspaceRoot: z.string().nullable(),
  /** False when the folder isn't a git repository: only the checkout itself is possible. */
  isRepo: z.boolean(),
  /** Branches a worktree can start from: local ones, then origin's. */
  branches: z.array(z.string()),
  /** The default branch, or the current one when there is no telling. */
  defaultBaseRef: z.string().nullable(),
  /** Each harness's model for the task's suggested tier, from Settings; null when none is set. */
  models: z.record(AgentHarness, CliModel.nullable()),
  /** The task's suggested tier, if any, to say where the model came from. */
  tier: z.enum(["light", "standard", "deep"]).nullable(),
  /** Whether sessions open in a Windows Terminal window named after the task (and can be brought back). */
  namedWindow: z.boolean(),
});
export type SessionLaunchOptions = z.infer<typeof SessionLaunchOptions>;

export const StartSessionInput = z.object({
  harness: AgentHarness,
  /** Picks the session's label: "Planning #N", "Implementing #N" or "Fixing the PR of #N". */
  mode: z.enum(["work", "plan", "fix"]),
  prompt: z.string().trim().min(1).max(100_000),
  /** Null runs the CLI's own default. */
  model: CliModel.nullable(),
  workspace: SessionWorkspace,
});
export type StartSessionInput = z.infer<typeof StartSessionInput>;

/**
 * What starting a session did. When the terminal won't start, `launched` is false and `command` is what to run by
 * hand. `shortPrompt` is set when the prompt couldn't go on the command line as written (too long, or characters the
 * shell can't be given safely): the CLI got a short pointer to the task instead, and the web app copies the full
 * prompt to the clipboard.
 */
export const StartSessionResult = z.object({
  launched: z.boolean(),
  command: z.string(),
  error: z.string().nullable(),
  /** The folder the session runs in: the new worktree, or the checkout. */
  cwd: z.string(),
  /** The new worktree's branch, when one was made. */
  branch: z.string().nullable(),
  shortPrompt: z.string().nullable(),
  /** Why the short prompt was used. */
  shortReason: z.string().nullable(),
  /** The session link, when the session was linked (always, once launched). */
  linkId: z.string().nullable(),
});
export type StartSessionResult = z.infer<typeof StartSessionResult>;

/** The Windows Terminal window a task's board-started sessions open in, e.g. `aboard-115`. */
export const taskWindowName = (taskNumber: number): string => `${BRAND.id.replace(/[^\w-]+/g, "-")}-${taskNumber}`;

/**
 * A window name the board made, so nothing else reaches wt's `-w`: not a number (a window id) or one of wt's own
 * names (`new`, `last`).
 */
export const isTaskWindowName = (name: string): boolean => name.length <= 80 && /^[A-Za-z][\w-]*-\d+$/.test(name);

/** "Implementing #115" / "Planning #115": the label the board links a session it started with. */
export const sessionLabel = (mode: "work" | "plan" | "fix", taskNumber: number): string =>
  mode === "fix"
    ? `Fixing the PR of #${taskNumber}`
    : `${mode === "plan" ? "Planning" : "Implementing"} #${taskNumber}`;

/**
 * The CLI's argv for a new session: its model and id, a name to find it by, and the first prompt as one argument.
 * Copilot CLI takes the prompt with `-i` (interactive); Claude Code as its positional argument, after `--`.
 */
export function newSessionArgv(input: {
  harness: AgentHarness;
  sessionId: string;
  model: string | null;
  name: string;
  prompt: string;
}): string[] {
  const model = input.model ? ["--model", input.model] : [];
  const cli = AGENT_HARNESSES[input.harness].cli;
  return input.harness === "claude-code"
    ? // `--` ends the options, so a prompt starting with "-" (a Markdown list item) isn't read as one.
      [cli, ...model, "--session-id", input.sessionId, "--name", input.name, "--", input.prompt]
    : [cli, ...model, "--session-id", input.sessionId, "--name", input.name, "-i", input.prompt];
}

/** The model a harness's CLI runs for a tier, from Settings → Models, or null for the CLI's default. */
export const tierCliModel = (tiers: ModelTiers, tier: ModelTier | null, harness: AgentHarness): string | null =>
  (tier && tiers[tier].cli?.[harness]?.trim()) || null;
