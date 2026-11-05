import type { AppSettings, BackupRemoteCheck, BackupSetupInfo, BackupStatus } from "@repo/contracts";

/** How the GitHub step gets a remote: a new private repo made with gh, or a URL the user gives. */
export type RemoteChoice = "create" | "existing" | "none";

/** What the Backup section shows: a setup button, a local-only warning, or the configured rows alone. */
export function backupState(settings: Pick<AppSettings, "backupDir" | "backupRemote">) {
  if (!settings.backupDir) return "unconfigured" as const;
  return settings.backupRemote ? ("remote" as const) : ("local_only" as const);
}

/** Clearing the folder also turns backup off: with no folder there is nothing to run. The remote and name stay. */
export const CLEAR_BACKUP_FOLDER = { backupEnabled: false, backupDir: null } as const;

/** Back to the state before setup; a null machine name follows the host name again. */
export const RESET_BACKUP_SETTINGS = {
  backupEnabled: false,
  backupDir: null,
  backupRemote: null,
  machineName: null,
} as const;

/**
 * Whether Reset has anything to clear. Clearing the folder leaves the remote and a custom name behind, so the
 * section is "unconfigured" while Reset is still the only way to drop them.
 */
export function canResetBackup(
  settings: Pick<AppSettings, "backupEnabled" | "backupDir" | "backupRemote" | "machineNameIsDefault">,
): boolean {
  return settings.backupEnabled || !!settings.backupDir || !!settings.backupRemote || !settings.machineNameIsDefault;
}

/** The choice the GitHub step starts on: creating a repo needs gh signed in, and a set remote is kept. */
export function initialRemoteChoice(info: BackupSetupInfo): RemoteChoice {
  if (info.backupRemote) return "existing";
  return info.gh.signedIn ? "create" : "existing";
}

/** The URL the existing-repo field starts with: the current remote, or where gh would have made the repo. */
export function suggestedRemote(info: BackupSetupInfo): string {
  if (info.backupRemote) return info.backupRemote;
  return info.gh.login ? `https://github.com/${info.gh.login}/${info.suggestedRepoName}.git` : "";
}

/** Why "Create a private repo" is unavailable, or null when it can be used. */
export function createUnavailableReason(info: BackupSetupInfo): string | null {
  if (!info.gh.available) return "Needs the GitHub CLI (gh), which isn't installed.";
  if (!info.gh.signedIn) return "Run gh auth login to sign gh in to GitHub, then check again.";
  return null;
}

export interface RemoteVerdict {
  /** Whether setup can go on with this remote. */
  ok: boolean;
  tone: "success" | "warning" | "error";
  message: string;
}

/** The check of an existing remote in words, and whether this machine can back up to it under `machineName`. */
export function remoteVerdict(check: BackupRemoteCheck, machineName: string): RemoteVerdict {
  switch (check.status) {
    case "not_found":
      return {
        ok: false,
        tone: "error",
        message: "No repo at that URL, or git's sign-in can't see it (GitHub hides private repos it can't read).",
      };
    case "auth_failed":
      return {
        ok: false,
        tone: "error",
        message:
          "git has no sign-in for this repo. For GitHub, run gh auth login and gh auth setup-git (or set up an SSH key), then check again.",
      };
    case "error":
      return { ok: false, tone: "error", message: check.message ?? "git couldn't read the repo." };
    case "reachable":
      break;
  }
  if (check.content === "other") {
    return {
      ok: false,
      tone: "error",
      message: "That repo holds other files. Use an empty repo or one that already holds backups.",
    };
  }
  if (check.content !== "backup" || check.machines.length === 0) {
    return { ok: true, tone: "success", message: `Empty repo: this machine backs up into ${machineName}/.` };
  }
  const others = check.machines.filter((m) => !m.current);
  const clash = others.find((m) => m.folder.toLowerCase() === machineName.toLowerCase() && m.instanceId !== null);
  const names = check.machines.map((m) => `${m.folder}/${m.current ? " (this machine)" : ""}`).join(", ");
  if (clash) {
    return {
      ok: false,
      tone: "warning",
      message: `Holds backups from ${names}. Another machine already uses ${clash.folder}/: give this one another name.`,
    };
  }
  return {
    ok: true,
    tone: "success",
    message: `Holds backups from ${names}. This machine backs up into ${machineName}/.`,
  };
}

/** How the first backup went, for the last step. */
export function firstBackupOutcome(status: BackupStatus, remote: string | null): RemoteVerdict {
  if (status.lastError) {
    // HTTPS pushes to GitHub only sign in through gh once `gh auth setup-git` has run, which `gh auth login` may skip.
    const auth = /could not read username|authentication failed|terminal prompts disabled/i.test(status.lastError);
    const hint = auth
      ? " git has no sign-in for the repo: run gh auth setup-git (or set up an SSH key), then try again."
      : "";
    return { ok: false, tone: "error", message: `${status.lastError}${hint}` };
  }
  if (remote && !status.lastPushAt) {
    // A scheduled run already going when the settings were saved is the one awaited, and it had the old ones.
    return { ok: false, tone: "warning", message: "Committed, but nothing was pushed yet. Try again to push." };
  }
  const what = status.lastCommit ? `committed ${status.lastCommit}` : "nothing new to commit";
  return {
    ok: true,
    tone: "success",
    message: remote ? `Backed up: ${what} and pushed.` : `Backed up on this machine: ${what}.`,
  };
}
