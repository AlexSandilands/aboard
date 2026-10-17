import { normalizeWorkspaceKey } from "@repo/contracts";
import type { RunGit } from "../integrations/backup.ts";

// One `git fetch origin` at a time per repository (docs/features/autopilot.md#runners). Two fetches in one checkout
// race for its ref locks and the loser fails, which is how parallel T3 launches lost their workspaces: each one's
// worktree starts with a fetch. Autopilot's T3 launches hold the gate until T3 has fetched, and the board's own
// fetches wait for it.

export interface RepoGate {
  /** Runs `fn` once every earlier holder of `repo` is done, in the order they asked. A throw releases it too. */
  run<T>(repo: string, fn: () => Promise<T>): Promise<T>;
}

export function createRepoGate(): RepoGate {
  // The tail of each repository's queue: the promise the next holder waits for.
  const tails = new Map<string, Promise<void>>();
  return {
    run(repo, fn) {
      const key = normalizeWorkspaceKey(repo);
      const before = tails.get(key) ?? Promise.resolve();
      const result = before.then(fn);
      // The next holder waits for this one to end, however it ends; the last one out leaves nothing behind.
      const tail: Promise<void> = result
        .catch(() => undefined)
        .finally(() => {
          if (tails.get(key) === tail) tails.delete(key);
        })
        .then(() => undefined);
      tails.set(key, tail);
      return result;
    },
  };
}

/** `runGit` with every `git fetch` going through the gate of the folder it runs in. */
export function gateFetches(runGit: RunGit, gate: RepoGate): RunGit {
  return (args, cwd) => (args[0] === "fetch" ? gate.run(cwd, () => runGit(args, cwd)) : runGit(args, cwd));
}
