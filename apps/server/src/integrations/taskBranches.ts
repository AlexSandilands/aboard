import { linkBranches, type TaskBranch, type TaskSummary } from "@repo/contracts";
import { canonicalPath, isInside } from "../autopilot/worktrees.ts";
import type { RunGit } from "./backup.ts";

// The task's own branches for the hand-off dialogs' pickers: its links' branches (contracts' linkBranches), the
// branch each agent session's folder has checked out, and the worktree each branch is checked out in. One
// `git worktree list` answers both git questions, the same way for every harness. See
// docs/features/agent-handoff.md#the-tasks-branches.

export interface GitWorktree {
  path: string;
  /** Null for a detached HEAD. */
  branch: string | null;
}

/** `git worktree list --porcelain`, main checkout first. Prunable entries (their folder is gone) are left out. */
export function parseWorktrees(porcelain: string): GitWorktree[] {
  const out: GitWorktree[] = [];
  for (const block of porcelain.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const path = lines
      .find((l) => l.startsWith("worktree "))
      ?.slice("worktree ".length)
      .trim();
    if (!path || lines.some((l) => l.startsWith("prunable"))) continue;
    const ref = lines
      .find((l) => l.startsWith("branch "))
      ?.slice("branch ".length)
      .trim();
    out.push({ path, branch: ref ? ref.replace(/^refs\/heads\//, "") : null });
  }
  return out;
}

/** The project's worktrees, or none when the folder isn't a repository or git fails. */
export async function worktreesOf(runGit: RunGit, root: string): Promise<GitWorktree[]> {
  const result = await runGit(["worktree", "list", "--porcelain"], root).catch(() => null);
  return result?.code === 0 ? parseWorktrees(result.stdout) : [];
}

/** The worktree a folder is in: the innermost one containing it. */
function worktreeAt(worktrees: readonly GitWorktree[], cwd: string): GitWorktree | null {
  const at = canonicalPath(cwd);
  let best: GitWorktree | null = null;
  for (const w of worktrees) {
    const path = canonicalPath(w.path);
    if (isInside(at, path) && (!best || isInside(path, canonicalPath(best.path)))) best = w;
  }
  return best;
}

export async function taskBranches(input: {
  task: Pick<TaskSummary, "links" | "integrationBranch">;
  /** The project's folder; null when it has none on this machine (only the links' branches are known then). */
  root: string | null;
  defaultBranch: string | null;
  runGit: RunGit;
  /** Already listed by the caller, to save a second git call. */
  worktrees?: readonly GitWorktree[];
}): Promise<TaskBranch[]> {
  const { task, root } = input;
  // Nothing to look up for a task with no links that name or imply a branch.
  if (!task.links.some((l) => l.kind === "pr" || l.kind === "t3_thread" || l.kind === "agent_session")) return [];
  const worktrees = input.worktrees ?? (root ? await worktreesOf(input.runGit, root) : []);
  // The project's own folder: usually the main checkout, but a project can live in a linked worktree too.
  const main = (root ? worktreeAt(worktrees, root) : null) ?? worktrees[0] ?? null;
  const branches = linkBranches(task.links, {
    sessionBranch: (link) => {
      const at = worktreeAt(worktrees, link.ref.cwd);
      // A session in the project's own folder says nothing about the task: the folder's branch is whatever the user
      // has checked out now, and planning sessions run there.
      if (!at || at === main) return null;
      return at.branch;
    },
    exclude: [input.defaultBranch, task.integrationBranch],
  });
  const byBranch = new Map(worktrees.filter((w) => w !== main && w.branch).map((w) => [w.branch!, w.path]));
  return branches.map((b) => ({ ...b, worktreePath: byBranch.get(b.name) ?? null }));
}

/** The worktree of the project with `branch` checked out at `path`, or null when there is no such live worktree. */
export async function findWorktree(
  runGit: RunGit,
  root: string,
  path: string,
  branch: string,
): Promise<GitWorktree | null> {
  const want = canonicalPath(path);
  const worktrees = await worktreesOf(runGit, root);
  // The project's own folder isn't a task's worktree: Current checkout runs there.
  const own = worktreeAt(worktrees, root);
  return worktrees.find((w) => w !== own && w.branch === branch && canonicalPath(w.path) === want) ?? null;
}
