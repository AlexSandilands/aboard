import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { RunGit } from "../integrations/backup.ts";

// Git worktrees for Autopilot's headless runs. Each run gets its own, under the board's data dir, so an agent never
// works in the user's checkout and runs side by side never share one.

/** The prefix of every branch Autopilot creates; cleanup only deletes branches with it. */
export const AUTOPILOT_BRANCH_PREFIX = "autopilot/";

export interface WorktreeRequest {
  /** The project's folder: any checkout of the repository. */
  repo: string;
  /** Where Autopilot keeps its worktrees. */
  root: string;
  taskNumber: number;
  runId: string;
  /** The ref a new branch starts from. Defaults to the default branch (origin's copy when there is one). */
  baseRef?: string | null | undefined;
  /** An existing branch to work on instead, e.g. a pull request's. Never the default branch, unless `readOnly`. */
  branch?: string | null | undefined;
  /** The agent can't push (a reviewer), so reading the default branch is harmless. */
  readOnly?: boolean | undefined;
  /** The new branch's prefix: Autopilot's by default; sessions the user starts from the board use their own. */
  branchPrefix?: string | undefined;
  /** Start from origin's copy of `baseRef` when there is one: a branch others merge into, such as an epic's. */
  baseFromOrigin?: boolean | undefined;
}

export interface Worktree {
  path: string;
  /** The local branch the worktree has checked out, always a new `autopilot/…` one (or `branchPrefix`'s). */
  branch: string;
  /** The branch on origin the work goes to: `branch` itself, or the existing branch asked for. */
  pushTo: string;
  defaultBranch: string | null;
}

/** Whether `child` is `parent` or inside it. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The path with its existing part resolved the way the file system names it, so two spellings of one folder compare
 * equal: a Windows short name (`RUNNER~1`) and its long name, or a symlink and its target. The part that doesn't
 * exist yet is kept as given.
 */
export function canonicalPath(path: string): string {
  const full = resolve(path);
  let existing = full;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  try {
    return join(realpathSync.native(existing), relative(existing, full));
  } catch {
    return full;
  }
}

const safeName = (name: string) => name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";

/**
 * The repository's default branch: origin's HEAD, else a local main or master. Null when there is no telling,
 * in which case Autopilot can only work on a branch it is given a base for.
 */
export async function defaultBranchOf(runGit: RunGit, repo: string): Promise<string | null> {
  const head = await runGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repo);
  if (head.code === 0 && head.stdout.trim().startsWith("origin/")) return head.stdout.trim().slice("origin/".length);
  for (const name of ["main", "master"]) {
    if (await refExists(runGit, repo, `refs/heads/${name}`)) return name;
  }
  return null;
}

export const refExists = async (runGit: RunGit, repo: string, ref: string) =>
  (await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo)).code === 0;

const gitError = (what: string, result: { stderr: string; stdout: string }) =>
  new Error(`${what}: ${(result.stderr || result.stdout).trim().slice(0, 300) || "git failed"}`);

/**
 * Makes a worktree for one run: a new `autopilot/<task#>-<run>` branch from the base ref, or from an existing
 * branch's tip when one is given (the agent then pushes to that branch). The new branch tracks nothing, so a bare
 * `git push` can't land on the branch it started from. Refuses the default branch and any folder in the checkout.
 */
export async function createWorktree(runGit: RunGit, req: WorktreeRequest): Promise<Worktree> {
  // Spawning in a missing folder fails the way a missing git does; say which it is.
  if (!existsSync(req.repo)) throw new Error(`The project folder ${req.repo} doesn't exist`);
  const top = await runGit(["rev-parse", "--show-toplevel"], req.repo);
  if (top.code !== 0) throw new Error(`${req.repo} isn't a git repository`);
  const checkout = resolve(top.stdout.trim());
  const defaultBranch = await defaultBranchOf(runGit, checkout);
  const hasOrigin = (await runGit(["remote", "get-url", "origin"], checkout)).code === 0;
  // Best effort: offline (or timed out), the local refs still give a starting point.
  if (hasOrigin) await runGit(["fetch", "--quiet", "origin"], checkout).catch(() => null);

  for (const name of [req.branch, req.baseRef]) {
    // Refs reach git as arguments; one starting with "-" would be read as an option.
    if (name?.startsWith("-")) throw new Error(`Not a branch name: ${name}`);
  }

  let start: string;
  let pushTo: string | null = null;
  if (req.branch) {
    if (req.branch === defaultBranch && !req.readOnly) {
      throw new Error(`Autopilot doesn't work on the default branch (${defaultBranch})`);
    }
    if (hasOrigin && (await refExists(runGit, checkout, `refs/remotes/origin/${req.branch}`))) {
      start = `origin/${req.branch}`;
    } else if (await refExists(runGit, checkout, `refs/heads/${req.branch}`)) {
      start = req.branch;
    } else {
      throw new Error(`No branch ${req.branch} to work on`);
    }
    pushTo = req.branch;
  } else if (req.baseRef) {
    start =
      req.baseFromOrigin && hasOrigin && (await refExists(runGit, checkout, `refs/remotes/origin/${req.baseRef}`))
        ? `origin/${req.baseRef}`
        : req.baseRef;
  } else if (defaultBranch) {
    start =
      hasOrigin && (await refExists(runGit, checkout, `refs/remotes/origin/${defaultBranch}`))
        ? `origin/${defaultBranch}`
        : defaultBranch;
  } else {
    throw new Error(`Can't tell ${checkout}'s default branch, so there is no base to start a worktree from`);
  }

  const name = `${req.taskNumber}-${req.runId.slice(0, 8)}`;
  const branch = `${req.branchPrefix ?? AUTOPILOT_BRANCH_PREFIX}${name}`;
  const path = join(resolve(req.root), safeName(basename(checkout)), name);
  const realPath = canonicalPath(path);
  const realCheckout = canonicalPath(checkout);
  if (isInside(realPath, realCheckout) || isInside(realCheckout, realPath)) {
    throw new Error(`Autopilot's worktree folder ${req.root} overlaps the checkout ${checkout}`);
  }
  if (existsSync(path)) throw new Error(`${path} already exists`);
  mkdirSync(dirname(path), { recursive: true });
  const added = await runGit(["worktree", "add", "--no-track", "-b", branch, path, start], checkout);
  if (added.code !== 0) throw gitError(`Couldn't add a worktree from ${start}`, added);
  return { path, branch, pushTo: pushTo ?? branch, defaultBranch };
}

export type RemoveOutcome = "removed" | "dirty" | "missing";

/**
 * Removes a run's worktree unless it has uncommitted changes. Its branch is deleted only when git sees it as
 * merged (`git branch -d`), so unpushed commits are never lost.
 */
export async function removeWorktree(runGit: RunGit, path: string): Promise<RemoveOutcome> {
  if (!existsSync(path)) return "missing";
  const status = await runGit(["status", "--porcelain"], path);
  if (status.code !== 0) throw gitError(`Couldn't read ${path}`, status);
  if (status.stdout.trim()) return "dirty";
  const head = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], path);
  const branch = head.code === 0 ? head.stdout.trim() : "";
  // The first worktree listed is the main checkout, which runs the removal.
  const list = await runGit(["worktree", "list", "--porcelain"], path);
  const main = /^worktree (.+)$/m.exec(list.stdout)?.[1]?.trim();
  if (list.code !== 0 || !main) throw gitError(`Couldn't find the checkout ${path} belongs to`, list);
  const removed = await runGit(["worktree", "remove", path], main);
  if (removed.code !== 0) throw gitError(`Couldn't remove ${path}`, removed);
  if (branch.startsWith(AUTOPILOT_BRANCH_PREFIX)) await runGit(["branch", "-d", branch], main);
  return "removed";
}
