import {
  AGENT_HARNESSES,
  CliModel,
  taskNumberList,
  type AgentHarness,
  type CliEffort,
  type CustomHandoffWorkspace,
  type SessionLaunchOptions,
  type SessionWorkspace,
  type StartSessionResult,
} from "@repo/contracts";
import { initialEffort } from "./cliEffort.logic";
import type { BranchRow, PinnedBranchRow } from "./handoff.logic";

/**
 * Where the dialog will start the session: a new worktree from a branch, a task's existing worktree, or the project's
 * checkout.
 */
export type SessionWhere =
  | { mode: "new_worktree"; baseRef: string | null }
  | { mode: "existing_worktree"; worktreePath: string; branch: string }
  | { mode: "current" };

/**
 * A new worktree when the folder is a repository, else the checkout itself. The worktree starts from the task's
 * integration branch when its epic has one (origin's copy first, as the T3 dialog does), else the default branch.
 */
export function initialWhere(
  options: Pick<SessionLaunchOptions, "isRepo" | "defaultBaseRef"> & Partial<Pick<SessionLaunchOptions, "branches">>,
  integrationBranch: string | null = null,
): SessionWhere {
  if (!options.isRepo) return { mode: "current" };
  const branches = options.branches ?? [];
  const epicRef = integrationBranch
    ? (branches.find((b) => b === `origin/${integrationBranch}`) ?? branches.find((b) => b === integrationBranch))
    : undefined;
  return { mode: "new_worktree", baseRef: epicRef ?? options.defaultBaseRef };
}

/**
 * Where a custom hand-off's dialog starts: the checkout, the task's own worktree when it has one, else what the dialog
 * would start in anyway (a new worktree in a repository).
 */
export function presetWhere(
  options: Pick<SessionLaunchOptions, "isRepo" | "defaultBaseRef" | "branches" | "taskBranches">,
  workspace: CustomHandoffWorkspace,
  integrationBranch: string | null = null,
): SessionWhere {
  if (workspace === "current") return { mode: "current" };
  const own = workspace === "task_worktree" && options.isRepo ? taskWorktreeWhere(options) : null;
  return own ?? initialWhere(options, integrationBranch);
}

/** The workspace to send, or null while a worktree has no branch to start from. */
export function toSessionWorkspace(where: SessionWhere): SessionWorkspace | null {
  if (where.mode === "current") return { mode: "current" };
  if (where.mode === "existing_worktree") return where;
  return where.baseRef ? { mode: "new_worktree", baseRef: where.baseRef } : null;
}

/**
 * The model a launch starts on: the suggested tier's model for this CLI when working; planning keeps the CLI's
 * default, as the tier is about implementing (the same rule as the T3 dialog).
 */
export function initialModel(
  options: Pick<SessionLaunchOptions, "models">,
  harness: AgentHarness,
  plan: boolean,
): string {
  return plan ? "" : (options.models[harness] ?? "");
}

/** The dialog's choices: the model ("" for the CLI's default), its effort, and where the session runs. */
export interface SessionPicks {
  model: string;
  effort: CliEffort | null;
  where: SessionWhere;
}

export function initialSessionPicks(
  options: SessionLaunchOptions,
  harness: AgentHarness,
  plan: boolean,
  integrationBranch: string | null,
  /** A custom hand-off's workspace, which the dialog opens on. */
  presetWorkspace: CustomHandoffWorkspace | null = null,
): SessionPicks {
  return {
    model: initialModel(options, harness, plan),
    effort: initialEffort(options, harness, plan),
    where: presetWorkspace
      ? presetWhere(options, presetWorkspace, integrationBranch)
      : initialWhere(options, integrationBranch),
  };
}

/** The choices with the options they were last made from, and whether the user has picked anything since. */
export interface SessionPickState {
  picks: SessionPicks | null;
  seededFrom: SessionLaunchOptions | undefined;
  touched: boolean;
}

export const emptySessionPickState: SessionPickState = { picks: null, seededFrom: undefined, touched: false };

/**
 * Makes the choices from the options once they are there, and again when a refresh brings different ones, but only
 * until the user has picked something: after that a refresh never moves a choice (as the T3 dialog's syncPicks).
 * The same state back when there is nothing to do, so the caller can tell.
 */
export function syncSessionPicks(
  state: SessionPickState,
  options: SessionLaunchOptions | undefined,
  harness: AgentHarness,
  plan: boolean,
  integrationBranch: string | null,
  presetWorkspace: CustomHandoffWorkspace | null = null,
): SessionPickState {
  if (!options) return state;
  if (state.picks && (options === state.seededFrom || state.touched)) return state;
  return {
    ...state,
    picks: initialSessionPicks(options, harness, plan, integrationBranch, presetWorkspace),
    seededFrom: options,
  };
}

/** A pick by the user: the choices change, and a refresh of the options stops moving them. */
export function pickSessionBy(
  state: SessionPickState,
  change: (picks: SessionPicks) => SessionPicks,
): SessionPickState {
  return state.picks ? { ...state, picks: change(state.picks), touched: true } : state;
}

/**
 * Plan with me switched: the model and effort follow the mode while they are still the ones the dialog chose (the
 * tier's model when working, the CLI's default when planning). Doesn't count as a pick.
 */
export function picksAfterPlanToggle(
  picks: SessionPicks,
  options: SessionLaunchOptions,
  harness: AgentHarness,
  plan: boolean,
): SessionPicks {
  if (picks.model !== initialModel(options, harness, plan)) return picks;
  const effort =
    picks.effort === initialEffort(options, harness, plan) ? initialEffort(options, harness, !plan) : picks.effort;
  return { ...picks, model: initialModel(options, harness, !plan), effort };
}

/** Why the model field can't be sent as typed, or null. Blank means the CLI's default. */
export function modelError(model: string): string | null {
  if (!model.trim()) return null;
  return CliModel.safeParse(model).success ? null : "A model name has only letters, digits and . : @ / [ ] -";
}

/**
 * The success toast for a started session: what was linked (or, for a CLI that picks its own session id, that the
 * session links itself), where it runs, and, when the CLI got the short prompt, where the full one is (`copied`: the
 * clipboard took it).
 */
export function startedDescription(
  result: Pick<StartSessionResult, "branch" | "shortPrompt" | "linkId">,
  harness: AgentHarness,
  /** The tasks the session is linked to: one, or several for a planning session. */
  taskNumbers: readonly number[],
  copied: boolean,
  /** The session runs in a task's existing worktree rather than a new one. */
  existingWorktree = false,
): string {
  const where = result.branch
    ? ` It runs in ${existingWorktree ? "the task's worktree" : "a new worktree"} on ${result.branch}.`
    : "";
  const short = !result.shortPrompt
    ? ""
    : copied
      ? " The full prompt is on your clipboard: paste it into the session."
      : " Copy the full prompt and paste it into the session.";
  const tasks = taskNumberList(taskNumbers.map((number) => ({ number })));
  if (!result.linkId) {
    // Nothing to link yet: the prompt asks the session to link itself, which shows on the card once it has.
    return `The session links itself to ${tasks} once ${harnessLabel(harness)} starts.${where}${short}`;
  }
  return `${tasks} ${taskNumbers.length === 1 ? "is" : "are"} linked to the new session.${where}${short}`;
}

export const harnessLabel = (harness: AgentHarness): string => AGENT_HARNESSES[harness].label;

// ── The task's own branches ──────────────────────────────────────────────

type BranchOptions = Pick<SessionLaunchOptions, "branches" | "taskBranches">;

/** The base a task branch gives a new worktree: the local branch, else origin's copy; null when neither is listed. */
const taskBaseRef = (options: BranchOptions, name: string): string | null =>
  options.branches.includes(name) ? name : options.branches.includes(`origin/${name}`) ? `origin/${name}` : null;

/** Where picking a pinned branch runs the session: in its worktree when it has one, else a new worktree from it. */
export function pickPinnedBranch(options: BranchOptions, name: string): SessionWhere | null {
  const branch = options.taskBranches?.find((b) => b.name === name);
  if (!branch) return null;
  if (branch.worktreePath) return { mode: "existing_worktree", worktreePath: branch.worktreePath, branch: name };
  const baseRef = taskBaseRef(options, name);
  return baseRef ? { mode: "new_worktree", baseRef } : null;
}

/** The pinned "This task" rows of the session dialog's picker. */
export function pinnedBranchRows(options: BranchOptions): PinnedBranchRow[] {
  return (options.taskBranches ?? []).map((branch) => {
    const baseRef = taskBaseRef(options, branch.name);
    return {
      value: branch.name,
      name: branch.name,
      badge: branch.worktreePath ? "worktree" : baseRef?.startsWith("origin/") ? "remote" : null,
      disabledReason:
        branch.worktreePath || baseRef ? null : "Not among the repository's branches: fetch it to start from it",
      sources: branch.sources,
      inactive: branch.inactive,
    };
  });
}

/** Every branch a new worktree can start from, as picker rows. */
export const branchRows = (options: BranchOptions): BranchRow[] =>
  options.branches.map((b) => ({
    value: b,
    name: b,
    badge: b.startsWith("origin/") ? "remote" : null,
    disabledReason: null,
  }));

/** The task's first branch with a worktree in picker order (open PRs first), for the Task worktree choice; null when none has one. */
export function taskWorktreeWhere(options: BranchOptions): SessionWhere | null {
  const branch = options.taskBranches?.find((b) => b.worktreePath);
  return branch ? { mode: "existing_worktree", worktreePath: branch.worktreePath!, branch: branch.name } : null;
}

/** The branch picker's label: "From <base>" for a new worktree, the branch for a task worktree. */
export function whereBranchLabel(where: SessionWhere): string {
  if (where.mode === "existing_worktree") return where.branch;
  if (where.mode === "new_worktree") return where.baseRef ? `From ${where.baseRef}` : "Choose a branch";
  return "";
}

/** The picked branch, to mark in the picker. */
export const whereBranch = (where: SessionWhere): string | null =>
  where.mode === "existing_worktree" ? where.branch : where.mode === "new_worktree" ? where.baseRef : null;
