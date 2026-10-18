import { existsSync } from "node:fs";
import { defaultBranchOf, refExists } from "../autopilot/worktrees.ts";
import type { RunGit } from "./backup.ts";

export interface DefaultBranchCommit {
  hash: string;
  at: string;
}

/**
 * Each non-merge commit on a project's default branch since `since`, with the time it landed (committer time, as an
 * ISO instant) and its hash, so a repository that several projects point at can be counted once.
 * It reads origin's copy of the branch when the checkout has one, else the local branch: the checkout may be on
 * another branch, and what counts is what reached the default branch. Throws a message fit to show the user when
 * the folder can't be read; callers treat that as "no commits", not as a failure.
 */
export async function defaultBranchCommits(runGit: RunGit, repo: string, since: Date): Promise<DefaultBranchCommit[]> {
  if (!existsSync(repo)) throw new Error(`the folder ${repo} doesn't exist`);
  if ((await runGit(["rev-parse", "--is-inside-work-tree"], repo)).code !== 0) {
    throw new Error(`${repo} isn't a git repository`);
  }
  const branch = await defaultBranchOf(runGit, repo);
  if (!branch) throw new Error(`can't tell ${repo}'s default branch`);
  // Full ref names: the branch name comes from the repository, and a bare one could be read as an option.
  const remote = `refs/remotes/origin/${branch}`;
  const local = `refs/heads/${branch}`;
  const ref = (await refExists(runGit, repo, remote)) ? remote : (await refExists(runGit, repo, local)) ? local : null;
  if (!ref) throw new Error(`can't tell ${repo}'s default branch`);
  // Whole seconds: git reads a fractional ISO time less reliably.
  const from = `${since.toISOString().slice(0, 19)}Z`;
  const log = await runGit(["log", ref, "--no-merges", `--since=${from}`, "--format=%H %cI", "--"], repo);
  if (log.code !== 0) throw new Error(`git log ${ref}: ${(log.stderr || log.stdout).trim().slice(0, 300) || "failed"}`);
  return log.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash = "", at = ""] = line.trim().split(" ");
      return { hash, at };
    });
}
