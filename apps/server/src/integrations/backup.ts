import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND, type BackupStatus } from "@repo/contracts";
import { AppError } from "../errors.ts";
import { isDumpDir, writeDumpDir } from "../services/backup/files.ts";
import type { Services } from "../services/types.ts";
import type { Logger } from "./util.ts";

/** How often the scheduler checks whether a backup is due (the interval itself is a setting). */
export const BACKUP_TICK_MS = 60_000;
/** Delay before the first backup after startup, so it doesn't compete with boot. */
const STARTUP_DELAY_MS = 15_000;
const GIT_TIMEOUT_MS = 2 * 60_000;
/** Files a host adds to a new repo (GitHub's "Add a README"), which don't make it someone else's repo. */
const REPO_BOILERPLATE = /^(readme|license|licence)(\.[\w.]+)?$|^\.git(ignore|attributes)$/i;

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type RunGit = (args: string[], cwd: string) => Promise<GitResult>;

// The machine's own git does the work, so pushing uses whatever credentials it already has (Git Credential
// Manager, SSH keys) and the board never stores a token. GIT_TERMINAL_PROMPT=0 makes a missing credential fail
// instead of waiting for input nobody will type.
const defaultRunGit: RunGit = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr });
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error("git was not found on PATH"));
        if (error.killed) return reject(new Error(`git ${args[0] ?? ""} timed out`));
        resolve({ code: typeof error.code === "number" ? error.code : 1, stdout, stderr });
      },
    );
  });

/** "Back up board: 2 tasks changed, 1 added" from `git status --porcelain` lines. */
export function commitMessage(changes: readonly string[]): string {
  const counts = { added: 0, changed: 0, removed: 0 };
  for (const line of changes) {
    if (!/ tasks\//.test(line)) continue;
    const code = line.slice(0, 2);
    if (/[A?]/.test(code)) counts.added += 1;
    else if (/D/.test(code)) counts.removed += 1;
    else counts.changed += 1;
  }
  const parts = [
    counts.changed ? `${counts.changed} task${counts.changed === 1 ? "" : "s"} changed` : null,
    counts.added ? `${counts.added} added` : null,
    counts.removed ? `${counts.removed} removed` : null,
  ].filter(Boolean);
  return `Back up board: ${parts.length ? parts.join(", ") : "settings and history"}`;
}

export interface BackupIntegration {
  status(): BackupStatus;
  /** Backs up now (joining a run in progress). Failures are recorded in the status, not thrown. */
  run(): Promise<BackupStatus>;
  start(): void;
  stop(): void;
}

/**
 * Scheduled backup: writes the dump into a local clone, commits when anything changed, and pushes. A failed push
 * leaves the commit queued locally; the next run pushes it.
 */
export function createBackupIntegration(deps: {
  services: () => Services;
  runGit?: RunGit;
  log?: Logger;
  now?: () => Date;
}): BackupIntegration {
  const runGit = deps.runGit ?? defaultRunGit;
  const log = deps.log ?? console;
  const now = deps.now ?? (() => new Date());
  const status: BackupStatus = {
    running: false,
    lastRunAt: null,
    lastCommitAt: null,
    lastCommit: null,
    lastPushAt: null,
    lastError: null,
  };
  let inFlight: Promise<BackupStatus> | null = null;
  const timers: NodeJS.Timeout[] = [];

  const git = async (dir: string, ...args: string[]): Promise<string> => {
    const result = await runGit(args, dir);
    if (result.code !== 0) throw new Error(`git ${args[0]}: ${(result.stderr || result.stdout).trim()}`);
    return result.stdout;
  };

  /** Whether `dir` holds our dump; throws if it holds another app's. */
  const isOurDump = (dir: string) => {
    if (!isDumpDir(dir)) return false;
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { app?: unknown };
    if (manifest.app !== BRAND.id) throw new AppError("VALIDATION", `${dir} holds a backup of ${String(manifest.app)}`);
    return true;
  };

  /** Clones or initialises the repo in `dir` when it's empty, refuses a folder that isn't a backup. */
  const prepareRepo = async (dir: string, remote: string | null) => {
    mkdirSync(dir, { recursive: true });
    if (readdirSync(dir).length === 0) {
      if (remote) await git(dir, "clone", "--", remote, ".");
      else await git(dir, "init");
    }
    if (!existsSync(join(dir, ".git"))) {
      if (!isOurDump(dir)) {
        throw new AppError("VALIDATION", `${dir} is not empty and holds no backup; choose an empty folder or a clone`);
      }
      await git(dir, "init");
    }
    // A repo created on GitHub with a README or licence is still an empty backup repo; anything else tracked
    // without our manifest is someone else's repo.
    const tracked = (await git(dir, "ls-files")).split("\n").filter(Boolean);
    if (tracked.some((path) => !REPO_BOILERPLATE.test(path)) && !isOurDump(dir)) {
      throw new AppError(
        "VALIDATION",
        `${dir} is a git repo with other content; choose an empty folder or a backup clone`,
      );
    }
    if (remote) {
      const current = await runGit(["remote", "get-url", "origin"], dir);
      if (current.code !== 0) await git(dir, "remote", "add", "--", "origin", remote);
      else if (current.stdout.trim() !== remote) {
        // Re-added rather than set-url, so the old remote's branches and our upstream go with it; the next pull
        // or push sets them up against the new remote.
        await git(dir, "remote", "remove", "origin");
        await git(dir, "remote", "add", "--", "origin", remote);
      }
    }
  };

  const commit = async (dir: string, message: string) => {
    // Use the machine's identity when it has one; a fresh machine gets the app's, rather than a failed commit.
    const identity =
      (await runGit(["config", "user.email"], dir)).code === 0
        ? []
        : ["-c", `user.name=${BRAND.name}`, "-c", `user.email=${BRAND.id}@localhost`];
    await git(dir, ...identity, "commit", "--quiet", "-m", message);
    status.lastCommit = (await git(dir, "rev-parse", "--short", "HEAD")).trim();
    status.lastCommitAt = now().toISOString();
  };

  /**
   * Brings in commits the remote has and the clone doesn't (a README edited on GitHub), so the push isn't
   * rejected. Returns an error message instead of throwing: offline, the run still commits locally.
   */
  const pull = async (dir: string): Promise<string | null> => {
    if (!(await upstreamOf(dir)) && !(await adoptRemoteBranch(dir))) return null;
    const result = await runGit(["pull", "--rebase", "--quiet"], dir);
    if (result.code === 0) return null;
    await runGit(["rebase", "--abort"], dir);
    return `git pull: ${(result.stderr || result.stdout).trim()}`;
  };

  /** "origin/main", or null when the branch tracks nothing. */
  const upstreamOf = async (dir: string): Promise<string | null> => {
    const result = await runGit(["rev-parse", "--abbrev-ref", "@{u}"], dir);
    return result.code === 0 ? result.stdout.trim() : null;
  };

  /**
   * Backups made before a remote was set have no upstream. When the remote already has a branch (a README made
   * on GitHub), track its default branch, so the pull rebases our commits onto it instead of every push being
   * rejected. False when there is nothing to track: offline, an empty remote, or no local commit yet.
   */
  const adoptRemoteBranch = async (dir: string): Promise<boolean> => {
    if ((await runGit(["fetch", "--quiet", "origin"], dir)).code !== 0) return false;
    if ((await runGit(["remote", "set-head", "origin", "--auto"], dir)).code !== 0) return false;
    const head = await runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir);
    if (head.code !== 0) return false;
    return (await runGit(["branch", `--set-upstream-to=${head.stdout.trim()}`], dir)).code === 0;
  };

  /** Pushes when HEAD is ahead of its upstream (to that branch, whatever ours is called), or has none yet. */
  const push = async (dir: string) => {
    if ((await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], dir)).code !== 0) return;
    const upstream = await upstreamOf(dir);
    if (upstream) {
      const ahead = await runGit(["rev-list", "--count", "@{u}..HEAD"], dir);
      if (ahead.code === 0 && ahead.stdout.trim() === "0") return;
      await git(dir, "push", "--quiet", "origin", `HEAD:${upstream.replace(/^origin\//, "")}`);
    } else {
      await git(dir, "push", "--quiet", "-u", "origin", "HEAD");
    }
    status.lastPushAt = now().toISOString();
  };

  const runOnce = async (): Promise<BackupStatus> => {
    const settings = deps.services().settings.get();
    const dir = settings.backupDir;
    try {
      if (!dir) throw new AppError("VALIDATION", "Choose a backup folder first");
      await prepareRepo(dir, settings.backupRemote);
      const pullError = settings.backupRemote ? await pull(dir) : null;
      writeDumpDir(dir, deps.services().backup.dump());
      await git(dir, "add", "-A");
      const changes = (await git(dir, "status", "--porcelain")).split("\n").filter(Boolean);
      if (changes.length > 0) await commit(dir, commitMessage(changes));
      if (settings.backupRemote) await push(dir);
      status.lastError = pullError;
    } catch (error) {
      status.lastError = error instanceof Error ? error.message : String(error);
      log.warn(`[backup] ${status.lastError}`);
    } finally {
      status.lastRunAt = now().toISOString();
    }
    return { ...status };
  };

  const run = () => {
    inFlight ??= runOnce().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const tick = () => {
    const settings = deps.services().settings.get();
    if (!settings.backupEnabled || !settings.backupDir || inFlight) return;
    const last = status.lastRunAt ? Date.parse(status.lastRunAt) : 0;
    if (now().getTime() - last >= settings.backupIntervalMinutes * 60_000) void run();
  };

  return {
    status: () => ({ ...status, running: inFlight !== null }),
    run,
    start() {
      if (timers.length > 0) return;
      timers.push(setTimeout(tick, STARTUP_DELAY_MS).unref(), setInterval(tick, BACKUP_TICK_MS).unref());
    },
    stop() {
      for (const timer of timers.splice(0)) clearTimeout(timer);
    },
  };
}
