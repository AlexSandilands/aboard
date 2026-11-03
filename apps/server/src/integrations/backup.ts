import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BRAND, type BackupMachine, type BackupStatus } from "@repo/contracts";
import { AppError } from "../errors.ts";
import { DUMP_ENTRIES, writeDumpDir } from "../services/backup/files.ts";
import { isBackupRepo, isFlatDump, machineFolders, writeRepoIndex } from "../services/backup/repo.ts";
import type { Services } from "../services/types.ts";
import type { Logger } from "./util.ts";

/** How often the scheduler checks whether a backup is due (the interval itself is a setting). */
export const BACKUP_TICK_MS = 60_000;
/** Delay before the first backup after startup, so it doesn't compete with boot. */
const STARTUP_DELAY_MS = 15_000;
const GIT_TIMEOUT_MS = 2 * 60_000;
/** Files a host adds to a new repo (GitHub's "Add a README"), which don't make it someone else's repo. */
export const REPO_BOILERPLATE = /^(readme|license|licence)(\.[\w.]+)?$|^\.git(ignore|attributes)$/i;

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type RunGit = (args: string[], cwd: string) => Promise<GitResult>;

// The machine's own git does the work, so pushing uses whatever credentials it already has (Git Credential
// Manager, SSH keys) and the board never stores a token. GIT_TERMINAL_PROMPT=0 makes a missing credential fail
// instead of waiting for input nobody will type.
export const defaultRunGit: RunGit = (args, cwd) =>
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

/** "Back up board: 2 tasks changed, 1 added" from `git status --porcelain` lines (task files sit in a machine folder). */
export function commitMessage(changes: readonly string[]): string {
  const counts = { added: 0, changed: 0, removed: 0 };
  for (const line of changes) {
    if (!/ ([^/ ]+\/)?tasks\//.test(line)) continue;
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
  /** The machines backed up to the repo in the backup folder, as of its last pull. */
  machines(): Promise<BackupMachine[]>;
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
  /** Where pasted images are stored; the dump copies them next to its JSON. */
  attachmentsDir: string;
  /** This board's id, which owns its machine folder in the repo. */
  instanceId: string;
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

  /** Clones or initialises the repo in `dir` when it's empty, refuses a folder that isn't a backup. */
  const prepareRepo = async (dir: string, remote: string | null) => {
    mkdirSync(dir, { recursive: true });
    if (readdirSync(dir).length === 0) {
      if (remote) await git(dir, "clone", "--", remote, ".");
      else await git(dir, "init");
    }
    if (!existsSync(join(dir, ".git"))) {
      if (!isBackupRepo(dir)) {
        throw new AppError("VALIDATION", `${dir} is not empty and holds no backup; choose an empty folder or a clone`);
      }
      await git(dir, "init");
    }
    // A repo created on GitHub with a README or licence is still an empty backup repo; anything else tracked
    // without a backup of ours (backup.json, a flat dump, or a machine folder) is someone else's repo.
    const tracked = (await git(dir, "ls-files")).split("\n").filter(Boolean);
    if (tracked.some((path) => !REPO_BOILERPLATE.test(path)) && !isBackupRepo(dir)) {
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

  // Use the machine's identity when it has one; a fresh machine gets the app's, rather than a failed commit.
  // The rebase in pull() needs it too: it rewrites our backup commits onto the remote's.
  const identity = async (dir: string): Promise<string[]> =>
    (await runGit(["config", "user.email"], dir)).code === 0
      ? []
      : ["-c", `user.name=${BRAND.name}`, "-c", `user.email=${BRAND.id}@localhost`];

  const commit = async (dir: string, message: string) => {
    await git(dir, ...(await identity(dir)), "commit", "--quiet", "-m", message);
    status.lastCommit = (await git(dir, "rev-parse", "--short", "HEAD")).trim();
    status.lastCommitAt = now().toISOString();
  };

  /** Stages everything and commits when anything changed. Returns whether it committed. */
  const commitAll = async (dir: string, message: string): Promise<boolean> => {
    await git(dir, "add", "-A");
    if (!(await git(dir, "status", "--porcelain")).trim()) return false;
    await commit(dir, message);
    return true;
  };

  /**
   * Renames a folder in the repo through a temporary name, so a change of case alone works on a case-insensitive
   * file system. A tracked folder is moved with git mv: with core.ignorecase (Windows, macOS) `git add` alone
   * wouldn't record a change of case.
   */
  const moveFolder = async (dir: string, from: string, to: string) => {
    const via = `${to}.moving-${process.pid}`;
    if ((await git(dir, "ls-files", "--", from)).trim()) {
      await git(dir, "mv", "--", from, via);
      await git(dir, "mv", "--", via, to);
    } else {
      renameSync(join(dir, from), join(dir, via));
      renameSync(join(dir, via), join(dir, to));
    }
  };

  const takenBy = (folder: string, machineName: string | null) =>
    new AppError(
      "CONFLICT",
      `The backup repo already has a folder ${folder} for another machine${machineName ? ` (${machineName})` : ""}; choose another machine name in Settings`,
    );

  /**
   * A flat backup (a dump at the repo's root, from before machine folders) moves into this machine's folder in a
   * commit of its own, so git follows each file's history across the move. Returns whether it moved.
   */
  const migrateFlat = async (dir: string, name: string): Promise<boolean> => {
    if (!isFlatDump(dir)) return false;
    const target = join(dir, name);
    if (existsSync(target)) {
      throw new AppError("CONFLICT", `${dir} holds a backup at its root and a ${name} folder; move one of them away`);
    }
    mkdirSync(target);
    for (const entry of DUMP_ENTRIES) {
      if (existsSync(join(dir, entry))) renameSync(join(dir, entry), join(target, entry));
    }
    // Temp files a crash left at the root would otherwise be committed with the move.
    for (const leftover of readdirSync(dir).filter((n) => n.endsWith(".json.tmp"))) rmSync(join(dir, leftover));
    writeRepoIndex(dir);
    await commitAll(dir, `Move the backup into ${name}/`);
    return true;
  };

  /**
   * Makes `name` this machine's folder: refuses a folder of that name (ignoring case, as Windows and macOS do) that
   * another machine owns, and renames this machine's folder when its name changed in Settings.
   */
  const claimFolder = async (dir: string, name: string) => {
    const folders = machineFolders(dir);
    const same = (f: { folder: string }) => f.folder.toLowerCase() === name.toLowerCase();
    const taken = folders.find((f) => same(f) && f.instanceId !== null && f.instanceId !== deps.instanceId);
    if (taken) throw takenBy(taken.folder, taken.machineName);
    const target = readdirSync(dir).find((n) => n.toLowerCase() === name.toLowerCase());
    if (target && !folders.some((f) => f.folder === target)) {
      throw new AppError(
        "CONFLICT",
        `The backup repo already has a ${target} that isn't a backup; choose another machine name in Settings`,
      );
    }
    const old = folders.find((f) => f.instanceId === deps.instanceId && f.folder !== name);
    // Only when nothing holds the new name: two folders of ours (copied by hand) are left for the user to sort out.
    if (!old || (target && target !== old.folder)) return;
    await moveFolder(dir, old.folder, name);
    await commitAll(dir, `Rename the backup folder ${old.folder}/ to ${name}/`);
  };

  /**
   * Brings in commits the remote has and the clone doesn't (another machine's backup, a README edited on GitHub),
   * so the push isn't rejected. Returns an error message instead of throwing: offline, the run still commits
   * locally. A pull that fails because of another machine's folder is handled by settleForeignConflict.
   */
  const pull = async (dir: string, name: string): Promise<string | null> => {
    if (!(await upstreamOf(dir)) && !(await adoptRemoteBranch(dir))) return null;
    const result = await runGit([...(await identity(dir)), "pull", "--rebase", "--quiet"], dir);
    if (result.code === 0) return null;
    await runGit(["rebase", "--abort"], dir);
    if (await settleForeignConflict(dir, name)) return null;
    return `git pull: ${(result.stderr || result.stdout).trim()}`;
  };

  /** The upstream's machine folders that another board owns, read from its tree (the pull didn't bring them in). */
  const foreignUpstreamFolders = async (dir: string) => {
    const tree = await runGit(["ls-tree", "-d", "--name-only", "@{u}"], dir);
    if (tree.code !== 0) return [];
    const folders = await Promise.all(
      tree.stdout
        .split("\n")
        .filter(Boolean)
        .map(async (folder) => {
          const shown = await runGit(["show", `@{u}:${folder}/manifest.json`], dir);
          if (shown.code !== 0) return [];
          try {
            const owner = JSON.parse(shown.stdout) as { instanceId?: unknown; machineName?: unknown };
            return typeof owner.instanceId === "string" && owner.instanceId !== deps.instanceId
              ? [{ folder, machineName: typeof owner.machineName === "string" ? owner.machineName : null }]
              : [];
          } catch {
            return [];
          }
        }),
    );
    return folders.flat();
  };

  /**
   * When this machine committed a folder before it saw the remote (it backed up with no remote set, or offline)
   * and another machine's folder of that name is upstream, the rebase stops on a conflict, every run, which
   * claimFolder can't see in the working tree. With the name still taken, throws "choose another machine name".
   * Once it has been renamed, the unpushed commits that wrote into the other machine's folder are set aside on a
   * local branch and the clone resets to the upstream; this run writes the whole dump again from the database into
   * this machine's folder. Returns whether it reset.
   */
  const settleForeignConflict = async (dir: string, name: string): Promise<boolean> => {
    const foreign = await foreignUpstreamFolders(dir);
    const taken = foreign.find((f) => f.folder.toLowerCase() === name.toLowerCase());
    if (taken) throw takenBy(taken.folder, taken.machineName);
    if (foreign.length === 0) return false;
    // The unpushed commits' files in those folders; `log` rather than a diff, as the histories may share no base.
    // Matched ignoring case like the clash itself: on Windows and macOS this machine's `laptop/` clashes with an
    // upstream `Laptop/`, and pathspecs match case exactly whatever core.ignorecase says.
    const touched = await runGit(
      ["log", "--name-only", "--format=", "@{u}..HEAD", "--", ...foreign.map((f) => `:(icase)${f.folder}`)],
      dir,
    );
    if (touched.code !== 0 || !touched.stdout.trim()) return false;
    // Those commits may be the only copy of this machine's older snapshots (it backed up with no remote), so they
    // stay on a local branch rather than going for good.
    const head = (await git(dir, "rev-parse", "--short", "HEAD")).trim();
    const kept = `unpushed-backups-${head}`;
    await git(dir, "branch", "--force", kept, "HEAD");
    await git(dir, "reset", "--hard", "--quiet", "@{u}");
    log.warn(`[backup] moved local backup commits that wrote into another machine's folder to the branch ${kept}`);
    deps.services().notifications.notify({
      kind: "backup_notice",
      title: "Older local backups set aside",
      body:
        `This machine's backups made before it joined the shared repo wrote into another machine's folder, so they ` +
        `couldn't be pushed. They are kept on the branch ${kept} in ${dir}; backups go on from now.`,
      dedupeKey: `backup_notice:set-aside:${head}`,
    });
    return true;
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

  const notifyMigrated = (name: string) => {
    deps.services().notifications.notify({
      kind: "backup_notice",
      title: `Backup moved into ${name}/`,
      body:
        `The backup repo now keeps this board in a folder of its own, ${name}/, so other machines can back up to ` +
        "the same repo. Older versions of the board can't back up to it any more: update them first.",
      dedupeKey: `backup_notice:migrated:${deps.instanceId}`,
    });
  };

  /** Each machine folder in the repo, with when a commit last touched it. */
  const machines = async (): Promise<BackupMachine[]> => {
    const dir = deps.services().settings.get().backupDir;
    if (!dir || !existsSync(join(dir, ".git"))) return [];
    return Promise.all(
      machineFolders(dir).map(async (f) => {
        const last = await runGit(["log", "-1", "--format=%cI", "--", f.folder], dir);
        const at = last.code === 0 ? last.stdout.trim() : "";
        return {
          folder: f.folder,
          instanceId: f.instanceId,
          machineName: f.machineName,
          current: f.instanceId === deps.instanceId,
          lastCommitAt: at ? new Date(at).toISOString() : null,
        };
      }),
    );
  };

  const runOnce = async (): Promise<BackupStatus> => {
    const settings = deps.services().settings.get();
    const dir = settings.backupDir;
    let pullError: string | null = null;
    try {
      if (!dir) throw new AppError("VALIDATION", "Choose a backup folder first");
      await prepareRepo(dir, settings.backupRemote);
      const name = settings.machineName;
      pullError = settings.backupRemote ? await pull(dir, name) : null;
      if (await migrateFlat(dir, name)) notifyMigrated(name);
      await claimFolder(dir, name);
      // A default name is kept from the first backup on: some host names change with the network (macOS), and
      // each change would otherwise move the folder.
      if (settings.machineNameIsDefault) deps.services().settings.update({ machineName: name });
      const dump = deps.services().backup.dump();
      dump.manifest = { ...dump.manifest, instanceId: deps.instanceId, machineName: name };
      writeDumpDir(join(dir, name), dump, deps.attachmentsDir);
      writeRepoIndex(dir);
      await git(dir, "add", "-A");
      const changes = (await git(dir, "status", "--porcelain")).split("\n").filter(Boolean);
      if (changes.length > 0) await commit(dir, commitMessage(changes));
      if (settings.backupRemote) await push(dir);
      status.lastError = pullError;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A failed pull is usually why the push was then rejected; keep it rather than only the symptom.
      status.lastError = pullError ? `${pullError}\n${message}` : message;
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
    machines,
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
