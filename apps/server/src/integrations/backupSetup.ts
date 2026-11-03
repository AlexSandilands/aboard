import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRAND,
  type BackupRemoteCheck,
  type BackupSetupInfo,
  type CreateBackupRepoResult,
  type GithubStatus,
} from "@repo/contracts";
import { AppError } from "../errors.ts";
import { isBackupRepo, machineFolders } from "../services/backup/repo.ts";
import type { Services } from "../services/types.ts";
import { REPO_BOILERPLATE, type RunGit } from "./backup.ts";
import { GhError, type RunGh } from "./gh.ts";

const GITHUB = "github.com";

/** The guided backup setup: what the dialog starts from, creating a private repo with gh, and checking a remote. */
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
  /** Re-detects gh and its sign-in, so a `gh auth login` made with the dialog open shows up. */
  ghStatus: () => Promise<GithubStatus>;
  runGh: RunGh;
  runGit: RunGit;
  /** `<data dir>/backup`. */
  defaultDir: string;
  instanceId: string;
}): BackupSetup {
  const signedIn = (status: GithubStatus) => {
    // A gh too old to list hosts only says whether it is signed in at all, which is to github.com.
    if (status.hosts.length === 0) return { signedIn: status.authenticated, login: null };
    const host = status.hosts.find((h) => h.host === GITHUB && h.authenticated);
    return { signedIn: Boolean(host), login: host?.login ?? null };
  };

  const info = async (): Promise<BackupSetupInfo> => {
    const status = await deps.ghStatus();
    const settings = deps.services().settings.get();
    return {
      gh: { available: status.available, ...signedIn(status) },
      defaultDir: deps.defaultDir,
      backupDir: settings.backupDir,
      backupRemote: settings.backupRemote,
      machineName: settings.machineName,
      machineNameIsDefault: settings.machineNameIsDefault,
      suggestedRepoName: `${BRAND.id}-backup`,
    };
  };

  const createRepo = async (name: string): Promise<CreateBackupRepoResult> => {
    const status = await deps.ghStatus();
    if (!status.available) throw new AppError("VALIDATION", "The GitHub CLI (gh) isn't installed");
    const { signedIn: ok, login } = signedIn(status);
    if (!ok) throw new AppError("VALIDATION", "gh isn't signed in to GitHub: run `gh auth login`, then try again");
    let stdout: string;
    try {
      stdout = await deps.runGh([
        "repo",
        "create",
        name,
        "--private",
        "--description",
        `Backups of the ${BRAND.name} board`,
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already exists/i.test(message)) {
        throw new AppError(
          "CONFLICT",
          `${login ?? "Your account"} already has a repo named ${name}: use it as an existing repo, or choose another name`,
        );
      }
      throw new AppError("INTERNAL", `gh repo create: ${message}`);
    }
    // gh prints the new repo's page; owner/name come from it, since gh may have been signed in as someone else.
    const url = stdout
      .trim()
      .split(/\s+/)
      .find((word) => /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(word));
    if (!url) throw new AppError("INTERNAL", `gh repo create printed no repo URL: ${stdout.trim()}`);
    // Push the way gh tells git to: over SSH when the user chose that, else HTTPS, which gh signs git in for.
    const protocol = await deps
      .runGh(["config", "get", "git_protocol", "--host", GITHUB])
      .then((out) => out.trim())
      .catch((error: unknown) => (error instanceof GhError ? "" : Promise.reject(error)));
    const path = url.slice(`https://${GITHUB}/`.length);
    return { url, remote: protocol === "ssh" ? `git@${GITHUB}:${path}.git` : `${url}.git` };
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
