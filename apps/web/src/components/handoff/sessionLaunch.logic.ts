import {
  AGENT_HARNESSES,
  CliModel,
  type AgentHarness,
  type SessionLaunchOptions,
  type SessionWorkspace,
  type StartSessionResult,
} from "@repo/contracts";

/** Where the dialog will start the session: a new worktree from a branch, or the project's checkout. */
export type SessionWhere = { mode: "new_worktree"; baseRef: string | null } | { mode: "current" };

/** A new worktree from the default branch when the folder is a repository, else the checkout itself. */
export function initialWhere(options: Pick<SessionLaunchOptions, "isRepo" | "defaultBaseRef">): SessionWhere {
  return options.isRepo ? { mode: "new_worktree", baseRef: options.defaultBaseRef } : { mode: "current" };
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
  taskNumber: number,
  copied: boolean,
): string {
  const where = result.branch ? ` It runs in a new worktree on ${result.branch}.` : "";
  const short = !result.shortPrompt
    ? ""
    : copied
      ? " The full prompt is on your clipboard: paste it into the session."
      : " Copy the full prompt and paste it into the session.";
  return `#${taskNumber} is linked to the new session.${where}${short}`;
}

export const harnessLabel = (harness: AgentHarness): string => AGENT_HARNESSES[harness].label;
