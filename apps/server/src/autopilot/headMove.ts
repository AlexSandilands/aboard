import type { RunGit } from "../integrations/backup.ts";

// How a PR's head moved since Review PRs last gave a verdict (docs/features/autopilot.md#review-prs). A move that only
// merges the PR's base branch in leaves the PR's own change as it was reviewed, so it costs no review round: git's own
// merge carries the verdict forward, and a merge whose conflicts someone resolved by hand gets a review of just that.

/** The most of the remerge-diff a resolution review is given; the reviewer reads the rest in the checkout. */
export const MAX_REMERGE_DIFF = 40_000;

export type HeadMove =
  /** Only merges of the base branch, each exactly what git merges on its own. */
  | { kind: "base_merge_clean"; merges: string[] }
  /**
   * Only merges of the base branch, at least one of them not what git merges on its own (conflicts resolved by hand,
   * or edits made in the merge). `diff` is `git show --remerge-diff` of those, capped; null when this git can't say.
   */
  | { kind: "base_merge_resolved"; merges: string[]; resolved: string[]; diff: string | null; truncated: boolean }
  /** Anything else: commits of the PR's own, a rewrite, a force-push, a merge of some other branch. */
  | { kind: "changed"; reason: string };

export interface HeadMoveInput {
  fromOid: string;
  toOid: string;
  /** The PR's base branch, read as `origin/<baseRef>`. */
  baseRef: string;
  /** The PR's branch, fetched with the base so both heads are local. */
  headRef?: string;
}

/** Git couldn't answer (no repository, a fetch that failed, a commit it doesn't have): not a verdict on the change. */
export class HeadMoveError extends Error {}

const OID = /^[0-9a-f]{40,64}$/;

/** Fetches the PR's base and head branches from origin, so both heads and the base are local. */
export async function fetchForHeadMove(runGit: RunGit, repo: string, input: HeadMoveInput): Promise<void> {
  const refspecs = [input.baseRef, ...(input.headRef ? [input.headRef] : [])].map(
    (branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  );
  const fetched = await runGit(["fetch", "--quiet", "--no-tags", "origin", ...refspecs], repo);
  if (fetched.code !== 0) {
    throw new HeadMoveError(`git fetch failed in ${repo}: ${fetched.stderr.trim() || `exit ${fetched.code}`}`);
  }
}

/**
 * Classifies the move from `fromOid` (the head the last verdict was about) to `toOid` with the repository's local git.
 * Fetch first (`fetchForHeadMove`). Strict on purpose: only a first-parent chain of merges from `fromOid`, each of
 * whose other parents is already on `origin/<baseRef>`, counts as a base merge. A merge git can't check (git older
 * than 2.38 has no `merge-tree --write-tree`) counts as resolved, so it is still reviewed.
 */
export async function classifyHeadMove(runGit: RunGit, repo: string, input: HeadMoveInput): Promise<HeadMove> {
  const { fromOid, toOid } = input;
  if (!OID.test(fromOid) || !OID.test(toOid)) throw new HeadMoveError("Not a commit id");
  const base = `refs/remotes/origin/${input.baseRef}`;
  const git = async (args: string[]) => runGit(args, repo);
  for (const ref of [fromOid, toOid, base]) {
    if ((await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code !== 0) {
      throw new HeadMoveError(`git has no commit ${ref} in ${repo}`);
    }
  }
  if (fromOid === toOid) return { kind: "base_merge_clean", merges: [] };
  if ((await git(["merge-base", "--is-ancestor", fromOid, toOid])).code !== 0) {
    return { kind: "changed", reason: "the branch was rewritten (the reviewed commit isn't in its history)" };
  }

  // Newest first: each line is a commit and its parents.
  const listed = await git(["rev-list", "--first-parent", "--parents", `${fromOid}..${toOid}`]);
  if (listed.code !== 0) throw new HeadMoveError(`git rev-list failed: ${listed.stderr.trim()}`);
  const chain = listed.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [sha, ...parents] = line.trim().split(/\s+/);
      return { sha: sha!, parents };
    });

  // The chain must step from the reviewed head through merges alone: each commit's first parent is the one before it.
  for (const [i, commit] of chain.entries()) {
    const expected = chain[i + 1]?.sha ?? fromOid;
    if (commit.parents[0] !== expected) {
      return { kind: "changed", reason: `${commit.sha.slice(0, 7)} doesn't build on the reviewed commit` };
    }
    if (commit.parents.length !== 2) {
      return {
        kind: "changed",
        reason:
          commit.parents.length < 2
            ? `${commit.sha.slice(0, 7)} is a commit of the PR's own, not a merge`
            : `${commit.sha.slice(0, 7)} merges more than one branch`,
      };
    }
    const other = commit.parents[1]!;
    if ((await git(["merge-base", "--is-ancestor", other, base])).code !== 0) {
      return { kind: "changed", reason: `${commit.sha.slice(0, 7)} merges in something that isn't ${input.baseRef}` };
    }
  }

  const merges = chain.map((c) => c.sha).reverse();
  const resolved: string[] = [];
  for (const commit of [...chain].reverse()) {
    const auto = await git(["merge-tree", "--write-tree", "--no-messages", commit.parents[0]!, commit.parents[1]!]);
    const autoTree = auto.code === 0 ? auto.stdout.split("\n")[0]!.trim() : null;
    const own = await git(["rev-parse", `${commit.sha}^{tree}`]);
    // Exit 1 is a conflict; anything else is a git that can't merge-tree --write-tree. Both need a look.
    if (autoTree === null || own.code !== 0 || autoTree !== own.stdout.trim()) resolved.push(commit.sha);
  }
  if (resolved.length === 0) return { kind: "base_merge_clean", merges };

  let diff = "";
  let readable = true;
  for (const sha of resolved) {
    const shown = await git(["show", "--remerge-diff", "--no-color", "--format=commit %H%n%s", sha]);
    if (shown.code !== 0) {
      readable = false;
      break;
    }
    diff += `${shown.stdout.trimEnd()}\n\n`;
  }
  const truncated = readable && diff.length > MAX_REMERGE_DIFF;
  return {
    kind: "base_merge_resolved",
    merges,
    resolved,
    diff: readable ? (truncated ? diff.slice(0, MAX_REMERGE_DIFF) : diff.trimEnd()) : null,
    truncated,
  };
}
