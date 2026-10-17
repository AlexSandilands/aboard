import { existsSync } from "node:fs";
import type { RunGit } from "../integrations/backup.ts";
import { defaultBranchOf } from "./worktrees.ts";

// An epic's integration branch (docs/features/epics.md#delivery): made on origin from origin's default branch when the
// epic switches to integration delivery, so its tasks have somewhere to start from and to open pull requests against.

export interface EpicBranch {
  branch: string;
  defaultBranch: string;
  /** False when origin already had the branch (switching back and forth, or a branch made by hand). */
  created: boolean;
}

const gitError = (what: string, result: { stderr: string; stdout: string }) =>
  new Error(`${what}: ${(result.stderr || result.stdout).trim().slice(0, 300) || "git failed"}`);

/**
 * Makes sure `branch` exists on origin, creating it from origin's default branch and pushing it when it doesn't. Never
 * the default branch itself, and never anything but a new ref: an existing branch is used as it is, not reset.
 */
export async function ensureEpicBranch(runGit: RunGit, repo: string, branch: string): Promise<EpicBranch> {
  if (!existsSync(repo)) throw new Error(`The project folder ${repo} doesn't exist`);
  if (branch.startsWith("-")) throw new Error(`Not a branch name: ${branch}`);
  const top = await runGit(["rev-parse", "--show-toplevel"], repo);
  if (top.code !== 0) throw new Error(`${repo} isn't a git repository`);
  const checkout = top.stdout.trim();
  if ((await runGit(["remote", "get-url", "origin"], checkout)).code !== 0) {
    throw new Error(`${checkout} has no remote named origin to push the epic's branch to`);
  }
  const fetched = await runGit(["fetch", "--quiet", "origin"], checkout);
  if (fetched.code !== 0) throw gitError("Couldn't fetch origin", fetched);
  const defaultBranch = await defaultBranchOf(runGit, checkout);
  if (!defaultBranch) throw new Error(`Can't tell ${checkout}'s default branch to start the epic's branch from`);
  if (branch === defaultBranch) throw new Error(`The epic's branch can't be the default branch (${defaultBranch})`);

  const exists = await runGit(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`], checkout);
  if (exists.code === 0) return { branch, defaultBranch, created: false };
  const base = `refs/remotes/origin/${defaultBranch}`;
  if ((await runGit(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], checkout)).code !== 0) {
    throw new Error(`origin has no ${defaultBranch} to start the epic's branch from`);
  }
  // A plain push of a new ref: it fails rather than move a branch someone else just made.
  const pushed = await runGit(["push", "origin", `${base}:refs/heads/${branch}`], checkout);
  if (pushed.code !== 0) throw gitError(`Couldn't push ${branch} to origin`, pushed);
  return { branch, defaultBranch, created: true };
}
