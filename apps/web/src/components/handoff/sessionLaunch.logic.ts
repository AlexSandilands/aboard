import {
  AGENT_HARNESSES,
  CliModel,
  taskNumberList,
  type AgentHarness,
  type CliEffort,
  type SessionLaunchOptions,
  type SessionWorkspace,
  type StartSessionResult,
} from "@repo/contracts";
import { initialEffort } from "./cliEffort.logic";

/** Where the dialog will start the session: a new worktree from a branch, or the project's checkout. */
export type SessionWhere = { mode: "new_worktree"; baseRef: string | null } | { mode: "current" };

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

/** The workspace to send, or null while a worktree has no branch to start from. */
export function toSessionWorkspace(where: SessionWhere): SessionWorkspace | null {
  if (where.mode === "current") return { mode: "current" };
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
): SessionPicks {
  return {
    model: initialModel(options, harness, plan),
    effort: initialEffort(options, harness, plan),
    where: initialWhere(options, integrationBranch),
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
): SessionPickState {
  if (!options) return state;
  if (state.picks && (options === state.seededFrom || state.touched)) return state;
  return { ...state, picks: initialSessionPicks(options, harness, plan, integrationBranch), seededFrom: options };
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
 * The success toast for a started session: what was linked, where it runs, and, when the CLI got the short prompt,
 * where the full one is (`copied`: the clipboard took it).
 */
export function startedDescription(
  result: Pick<StartSessionResult, "branch" | "shortPrompt">,
  /** The tasks the session is linked to: one, or several for a planning session. */
  taskNumbers: readonly number[],
  copied: boolean,
): string {
  const where = result.branch ? ` It runs in a new worktree on ${result.branch}.` : "";
  const short = !result.shortPrompt
    ? ""
    : copied
      ? " The full prompt is on your clipboard: paste it into the session."
      : " Copy the full prompt and paste it into the session.";
  const linked = `${taskNumberList(taskNumbers.map((number) => ({ number })))} ${taskNumbers.length === 1 ? "is" : "are"}`;
  return `${linked} linked to the new session.${where}${short}`;
}

export const harnessLabel = (harness: AgentHarness): string => AGENT_HARNESSES[harness].label;
