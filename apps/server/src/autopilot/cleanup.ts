import { existsSync } from "node:fs";
import { defaultRunGit, type RunGit } from "../integrations/backup.ts";
import { messageOf } from "../integrations/github.ts";
import type { Logger } from "../integrations/util.ts";
import type { Services } from "../services/types.ts";
import { removeWorktree } from "./worktrees.ts";

export const WORKTREE_CLEANUP_INTERVAL_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface WorktreeCleanup {
  /** One pass over finished headless runs; resolves when it is done. */
  sweep(): Promise<void>;
  start(): void;
  stop(): void;
}

/**
 * Removes the worktrees of finished headless runs once the task's PR has merged, or once the run is older than the
 * engine's retention. A worktree with uncommitted changes is kept and logged once; removing it is the user's call.
 */
export function createWorktreeCleanup(deps: {
  services: () => Services;
  runGit?: RunGit;
  now?: () => number;
  log?: Logger;
}): WorktreeCleanup {
  const runGit = deps.runGit ?? defaultRunGit;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console;
  /** Dirty worktrees already logged, so each is reported once per server run rather than every hour. */
  const reported = new Set<string>();
  let sweeping: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const merged = (s: Services, taskId: string | null): boolean => {
    if (!taskId) return false;
    try {
      return s.tasks.summary(taskId).links.some((l) => l.kind === "pr" && l.snapshot?.state === "merged");
    } catch {
      return false;
    }
  };

  const pass = async () => {
    const s = deps.services();
    const retentionMs = s.autopilot.engine().worktreeRetentionDays * DAY_MS;
    for (const run of s.autopilot.finishedWithWorktree()) {
      const path = run.worktreePath!;
      if (!existsSync(path)) continue;
      const old = now() - Date.parse(run.finishedAt!) >= retentionMs;
      if (!old && !merged(s, run.taskId)) continue;
      try {
        const outcome = await removeWorktree(runGit, path);
        if (outcome === "dirty" && !reported.has(path)) {
          reported.add(path);
          log.warn(`[autopilot] kept the worktree ${path}: it has uncommitted changes`);
        }
      } catch (error) {
        log.warn(`[autopilot] couldn't remove the worktree ${path}: ${messageOf(error)}`);
      }
    }
  };

  const sweep = () => {
    sweeping ??= pass().finally(() => {
      sweeping = null;
    });
    return sweeping;
  };

  return {
    sweep,
    start() {
      timer ??= setInterval(() => void sweep(), WORKTREE_CLEANUP_INTERVAL_MS);
      void sweep();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
