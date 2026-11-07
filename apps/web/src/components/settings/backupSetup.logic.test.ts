import type { BackupMachine, BackupRemoteCheck, BackupSetupInfo, BackupStatus } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  backupState,
  canResetBackup,
  CLEAR_BACKUP_FOLDER,
  RESET_BACKUP_SETTINGS,
  createUnavailableReason,
  firstBackupOutcome,
  initialRemoteChoice,
  remoteVerdict,
  suggestedRemote,
} from "./backupSetup.logic";

const info = (over: Partial<BackupSetupInfo> = {}): BackupSetupInfo => ({
  host: { kind: "github", available: true, signedIn: true, login: "octocat" },
  defaultDir: "/data/backup",
  backupDir: null,
  backupRemote: null,
  machineName: "laptop",
  machineNameIsDefault: true,
  suggestedRepoName: "board-backup",
  ...over,
});
const noGh = info({ host: { kind: "github", available: false, signedIn: false, login: null } });
const signedOut = info({ host: { kind: "github", available: true, signedIn: false, login: null } });

describe("backupState", () => {
  it("tells unconfigured, local-only and pushing backups apart", () => {
    expect(backupState({ backupDir: null, backupRemote: null })).toBe("unconfigured");
    expect(backupState({ backupDir: "/b", backupRemote: null })).toBe("local_only");
    expect(backupState({ backupDir: "/b", backupRemote: "git@github.com:o/r.git" })).toBe("remote");
  });
});

describe("clearing and resetting", () => {
  const unset = { backupEnabled: false, backupDir: null, backupRemote: null, machineNameIsDefault: true };

  it("offers Reset only while something is set, including what Clear leaves behind", () => {
    expect(canResetBackup(unset)).toBe(false);
    expect(canResetBackup({ ...unset, backupDir: "/b" })).toBe(true);
    expect(canResetBackup({ ...unset, backupRemote: "git@github.com:o/r.git" })).toBe(true);
    expect(canResetBackup({ ...unset, machineNameIsDefault: false })).toBe(true);
    expect(canResetBackup({ ...unset, backupEnabled: true })).toBe(true);
  });

  it("clears the folder and switches backup off, keeping the remote and name", () => {
    expect(CLEAR_BACKUP_FOLDER).toEqual({ backupEnabled: false, backupDir: null });
    expect(backupState({ backupDir: null, backupRemote: "git@github.com:o/r.git" })).toBe("unconfigured");
  });

  it("resets the folder, remote and name together, so setup starts over", () => {
    expect(RESET_BACKUP_SETTINGS).toEqual({
      backupEnabled: false,
      backupDir: null,
      backupRemote: null,
      machineName: null,
    });
  });
});

describe("the GitHub step", () => {
  it("with gh signed in, offers to create the repo under the account", () => {
    expect(initialRemoteChoice(info())).toBe("create");
    expect(createUnavailableReason(info())).toBeNull();
    expect(suggestedRemote(info())).toBe("https://github.com/octocat/board-backup.git");
  });

  it("without gh, or signed out, falls back to an existing repo and says why", () => {
    expect(initialRemoteChoice(noGh)).toBe("existing");
    expect(createUnavailableReason(noGh)).toMatch(/isn't installed/);
    expect(suggestedRemote(noGh)).toBe("");
    expect(initialRemoteChoice(signedOut)).toBe("existing");
    expect(createUnavailableReason(signedOut)).toMatch(/gh auth login/);
  });

  it("keeps a remote that is already set", () => {
    const set = info({ backupRemote: "https://example.com/x.git" });
    expect(initialRemoteChoice(set)).toBe("existing");
    expect(suggestedRemote(set)).toBe("https://example.com/x.git");
  });
});

describe("remoteVerdict", () => {
  const check = (over: Partial<BackupRemoteCheck>): BackupRemoteCheck => ({
    status: "reachable",
    message: null,
    content: "empty",
    machines: [],
    ...over,
  });
  const machine = (folder: string, current = false): BackupMachine => ({
    folder,
    instanceId: current ? "me" : `id-${folder}`,
    machineName: folder,
    current,
    lastCommitAt: null,
  });

  it("accepts an empty repo", () => {
    expect(remoteVerdict(check({}), "laptop")).toMatchObject({ ok: true, message: expect.stringContaining("laptop/") });
  });

  it("lists the machines in an existing backup repo", () => {
    const verdict = remoteVerdict(check({ content: "backup", machines: [machine("desktop")] }), "laptop");
    expect(verdict).toMatchObject({ ok: true, tone: "success" });
    expect(verdict.message).toContain("desktop/");
  });

  it("refuses a name another machine has, ignoring case, but not this machine's own folder", () => {
    const repo = check({ content: "backup", machines: [machine("Laptop")] });
    expect(remoteVerdict(repo, "laptop")).toMatchObject({ ok: false, tone: "warning" });
    const own = check({ content: "backup", machines: [machine("laptop", true)] });
    expect(remoteVerdict(own, "laptop")).toMatchObject({ ok: true });
    expect(remoteVerdict(own, "laptop").message).toContain("(this machine)");
  });

  it("refuses someone else's repo and explains git's failures", () => {
    expect(remoteVerdict(check({ content: "other" }), "laptop").ok).toBe(false);
    expect(remoteVerdict(check({ status: "not_found", content: null }), "laptop").message).toMatch(/No repo/);
    expect(remoteVerdict(check({ status: "auth_failed", content: null }), "laptop").message).toMatch(/gh auth login/);
    expect(remoteVerdict(check({ status: "error", content: null, message: "offline" }), "laptop").message).toBe(
      "offline",
    );
  });
});

describe("firstBackupOutcome", () => {
  const status = (over: Partial<BackupStatus>): BackupStatus => ({
    running: false,
    lastRunAt: "2026-11-03T10:00:00.000Z",
    lastCommitAt: "2026-11-03T10:00:00.000Z",
    lastCommit: "abc1234",
    lastPushAt: "2026-11-03T10:00:00.000Z",
    lastError: null,
    ...over,
  });

  it("says it pushed, or that it stays local", () => {
    expect(firstBackupOutcome(status({}), "r")).toMatchObject({ ok: true, message: expect.stringContaining("pushed") });
    expect(firstBackupOutcome(status({ lastPushAt: null }), null)).toMatchObject({
      ok: true,
      message: expect.stringContaining("on this machine"),
    });
  });

  it("shows the error, and a remote that wasn't pushed to", () => {
    expect(firstBackupOutcome(status({ lastError: "git push: denied" }), "r")).toMatchObject({
      ok: false,
      message: "git push: denied",
    });
    expect(firstBackupOutcome(status({ lastPushAt: null }), "r")).toMatchObject({ ok: false, tone: "warning" });
    const auth = status({ lastError: "git push: fatal: could not read Username for 'https://github.com'" });
    expect(firstBackupOutcome(auth, "r").message).toMatch(/gh auth setup-git/);
  });
});
