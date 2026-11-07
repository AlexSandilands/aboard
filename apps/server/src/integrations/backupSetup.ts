import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRAND,
  type BackupRemoteCheck,
  type BackupSetupInfo,
  type CreateBackupRepoResult,
  type GitHostStatus,
} from "@repo/contracts";
import { AppError } from "../errors.ts";
import { isBackupRepo, machineFolders } from "../services/backup/repo.ts";
import type { Services } from "../services/types.ts";
import { REPO_BOILERPLATE, type RunGit } from "./backup.ts";
import type { GitHost } from "./gitHost.ts";

/** The guided backup setup: what the dialog starts from, creating a private repo on the git host, and checking a remote. */
export interface BackupSetup {
  info(): Promise<BackupSetupInfo>;
  createRepo(name: string): Promise<CreateBackupRepoResult>;
  checkRemote(remote: string): Promise<BackupRemoteCheck>;
}

/** Sorts git's complaint about a remote it can't read into what the dialog tells the user to do. */
export function remoteFailure(stderr: string): Exclude<BackupRemoteCheck["status"], "reachable"> {
  // Checked first: GitHub answers "Repository not found" for a private repo the signed-in account can't see, too.
  if (/repository not found|not found|does not appear to be a git repository|does not exist/i.test(stderr)) {
    return "not_found";
  }
  if (/authentication failed|could not read username|terminal prompts disabled|permission denied|403/i.test(stderr)) {
    return "auth_failed";
  }
  return "error";
}

export function createBackupSetup(deps: {
  services: () => Services;
  /**
   * The git host a new repo is made on. Its status is read again each time, so a sign-in made with the dialog open
   * shows up.
   */
  host: Pick<GitHost, "kind" | "definition" | "checkStatus" | "createRepo">;
  runGit: RunGit;
  /** `<data dir>/backup`. */
  defaultDir: string;
  instanceId: string;
}): BackupSetup {
  const { host } = deps;
  const { cli } = host.definition;
  /** The host's main site, where a new repo is made: github.com for GitHub. */
  const site = host.definition.kind === "github" ? "github.com" : null;

  const signedIn = (status: GitHostStatus) => {
    // A CLI too old to list hosts only says whether it is signed in at all, which is to the main site.
    if (status.accounts.length === 0) return { signedIn: status.authenticated, login: null };
    const account = status.accounts.find((h) => h.host === site && h.authenticated);
    return { signedIn: Boolean(account), login: account?.login ?? null };
  };

  const info = async (): Promise<BackupSetupInfo> => {
    const status = await host.checkStatus();
    const settings = deps.services().settings.get();
    return {
      host: { kind: host.kind, available: status.available, ...signedIn(status) },
      defaultDir: deps.defaultDir,
      backupDir: settings.backupDir,
      backupRemote: settings.backupRemote,
      machineName: settings.machineName,
      machineNameIsDefault: settings.machineNameIsDefault,
      suggestedRepoName: `${BRAND.id}-backup`,
    };
  };

  const createRepo = async (name: string): Promise<CreateBackupRepoResult> => {
    const status = await host.checkStatus();
    if (!status.available) throw new AppError("VALIDATION", `The ${cli.label} (${cli.name}) isn't installed`);
    const { signedIn: ok, login } = signedIn(status);
    if (!ok) {
      throw new AppError(
        "VALIDATION",
        `${cli.name} isn't signed in to ${host.definition.label}: run \`${cli.loginCommand()}\`, then try again`,
      );
    }
    try {
      const repo = await host.createRepo(name, { description: `Backups of the ${BRAND.name} board` });
      return { url: repo.webUrl, remote: repo.pushUrl };
    } catch (error) {
      if (error instanceof AppError && error.code === "CONFLICT") {
        throw new AppError(
          "CONFLICT",
          `${login ?? "Your account"} already has a repo named ${name}: use it as an existing repo, or choose another name`,
        );
      }
      throw error;
    }
  };

  const checkRemote = async (remote: string): Promise<BackupRemoteCheck> => {
    const scratch = mkdtempSync(join(tmpdir(), `${BRAND.id}-remote-check-`));
    try {
      const heads = await deps.runGit(["ls-remote", "--heads", "--", remote], scratch);
      if (heads.code !== 0) {
        const message = (heads.stderr || heads.stdout).trim();
        return { status: remoteFailure(message), message, content: null, machines: [] };
      }
      if (!heads.stdout.trim()) return { status: "reachable", message: null, content: "empty", machines: [] };
      // Only the latest commit is needed to see what the repo holds.
      const clone = join(scratch, "repo");
      const cloned = await deps.runGit(["clone", "--quiet", "--depth", "1", "--", remote, clone], scratch);
      if (cloned.code !== 0) {
        const message = (cloned.stderr || cloned.stdout).trim();
        return { status: remoteFailure(message), message, content: null, machines: [] };
      }
      let backup: boolean;
      try {
        backup = isBackupRepo(clone);
      } catch {
        // A manifest or backup.json of another app's.
        backup = false;
      }
      if (!backup) {
        const files = readdirSync(clone).filter((name) => name !== ".git");
        const content = files.every((name) => REPO_BOILERPLATE.test(name)) ? "empty" : "other";
        return { status: "reachable", message: null, content, machines: [] };
      }
      const machines = machineFolders(clone).map((f) => ({
        folder: f.folder,
        instanceId: f.instanceId,
        machineName: f.machineName,
        current: f.instanceId === deps.instanceId,
        lastCommitAt: null,
      }));
      return { status: "reachable", message: null, content: "backup", machines };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  return { info, createRepo, checkRemote };
}
