import { z } from "zod";

// A backup is the board's tables written out as JSON, one file per task, so it diffs well in git. Rows keep the
// database's own column names: a dump is restored into a database migrated to the dump's schema version, so the
// columns always line up, and a newer server migrates the rows forward afterwards (see docs/features/backup.md).

/** Bumped when the layout of the dump (files, keys) changes, not when the schema does. */
export const BACKUP_FORMAT_VERSION = 1;

// The git backup repo holds one folder per machine, so several machines can share one repo:
//
//   backup.json        BackupRepoIndex: marks the repo as ours and versions this layout
//   laptop/            one machine's dump, in the folder layout above (manifest.json, tasks/, ...)
//   desktop/
//
// Each machine writes only its own folder, and backup.json holds nothing per machine, so two machines pushing to
// the same repo never conflict. Whose folder is whose is in each folder's manifest (instanceId). A dump's own
// layout didn't change, so it keeps BACKUP_FORMAT_VERSION; the repo layout has a version of its own. A flat repo
// (a dump at the root, from before machine folders) is moved into this machine's folder by the next backup run.

/** Bumped when the repo layout (backup.json, the machine folders) changes. */
export const BACKUP_REPO_FORMAT_VERSION = 1;

/** `backup.json` at the root of a git backup repo. Nothing in it is per machine: see the layout above. */
export const BackupRepoIndex = z.object({
  /** The product id, so the board never writes into another app's repo. */
  app: z.string(),
  /** BACKUP_REPO_FORMAT_VERSION of the version that wrote the layout. */
  repoFormat: z.number().int(),
});
export type BackupRepoIndex = z.infer<typeof BackupRepoIndex>;

/** Longest machine name: it is a folder name in the repo. */
export const MACHINE_NAME_MAX = 64;
/**
 * Folders a flat dump has at its root, so a machine folder can't be mistaken for part of one (its files, and
 * backup.json, all end in ".json", which no name may), plus the device names Windows can't use as a folder name,
 * with or without an extension.
 */
const RESERVED_MACHINE_NAMES = new Set(["tasks", "events", "attachments"]);
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * A machine's name, which is its folder in the backup repo: letters, digits, ".", "_" and "-", starting with a letter
 * or digit (so it can't be ".git"), and none of the names below, so it is a valid folder name on every OS.
 */
export const MachineName = z
  .string()
  .trim()
  .min(1, "Give the machine a name")
  .max(MACHINE_NAME_MAX, `At most ${MACHINE_NAME_MAX} characters`)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Use letters, digits, '.', '_' or '-', starting with a letter or digit")
  .refine(
    (name) => !RESERVED_MACHINE_NAMES.has(name.toLowerCase()) && !/\.json$/i.test(name),
    "That name is used by the backup itself",
  )
  // Windows drops a trailing dot, and can't make a folder named after a device: the repo couldn't be checked out.
  .refine((name) => !name.endsWith(".") && !WINDOWS_DEVICE_NAME.test(name), "Windows can't use that as a folder name");

/** The default machine name from a host name: invalid characters become "-", and an unusable name "machine". */
export function machineNameFrom(hostname: string): string {
  const name = hostname
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, MACHINE_NAME_MAX)
    .replace(/\.+$/, "");
  return MachineName.safeParse(name).success ? name : "machine";
}

/** One table row as stored: column name to value. */
export const BackupRow = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));
export type BackupRow = z.infer<typeof BackupRow>;

export const BackupManifest = z.object({
  format: z.number().int(),
  /** The product id, so a restore can tell its dumps from anything else. */
  app: z.string(),
  appVersion: z.string(),
  /** The last migration applied to the dumped database, e.g. "007_suggested_model.sql". */
  schemaVersion: z.string(),
  /** Rows per table, checked after a restore. */
  counts: z.record(z.string(), z.number().int().min(0)),
  /**
   * The board that wrote this dump into a backup repo, which owns its machine folder. Absent from dumps taken by
   * hand and from backups made before machine folders.
   */
  instanceId: z.string().optional(),
  /** That machine's name when it wrote the dump. Absent like instanceId. */
  machineName: z.string().optional(),
});
export type BackupManifest = z.infer<typeof BackupManifest>;

/** Tables whose rows belong to one task, in the order they are inserted. */
export const TASK_BUNDLE_TABLES = [
  "plan_phases",
  "plan_steps",
  "task_links",
  "task_attachments",
  "task_labels",
  "task_reviews",
  "review_findings",
] as const;

/** A task and the rows that belong to it: one file per task. Its events are kept apart, by month. */
export const TaskBundle = z.object({
  task: BackupRow,
  plan_phases: z.array(BackupRow),
  plan_steps: z.array(BackupRow),
  task_links: z.array(BackupRow),
  /** Pasted images: the rows; the files are beside the JSON, in `attachments/`. Absent before attachments existed. */
  task_attachments: z.array(BackupRow).default([]),
  task_labels: z.array(BackupRow),
  task_reviews: z.array(BackupRow),
  review_findings: z.array(BackupRow),
});
export type TaskBundle = z.infer<typeof TaskBundle>;

/** The whole board in memory: what a folder dump holds, and the single-file form as is. */
export const BoardDump = z.object({
  manifest: BackupManifest,
  settings: z.array(BackupRow),
  projects: z.array(BackupRow),
  label_colors: z.array(BackupRow),
  counters: z.array(BackupRow),
  /** Absent from dumps taken before templates existed. */
  task_templates: z.array(BackupRow).default([]),
  /** Blocks / blocked-by pairs. Backups from before relations existed have none. */
  task_relations: z.array(BackupRow).default([]),
  /** Autopilot switches and config per scope. Dumps taken before Autopilot have none. */
  autopilot_settings: z.array(BackupRow).default([]),
  /** Recurring-task rules. Dumps taken before Recurring tasks have none. */
  autopilot_recurring: z.array(BackupRow).default([]),
  /** Custom automations. Dumps taken before them have none. */
  autopilot_custom: z.array(BackupRow).default([]),
  /** Suggested changes to prompts and skills. Dumps taken before them have none. */
  suggestions: z.array(BackupRow).default([]),
  tasks: z.array(TaskBundle),
  task_events: z.array(BackupRow),
});
export type BoardDump = z.infer<typeof BoardDump>;

export const BACKUP_INTERVAL_MIN = 5;
export const BACKUP_INTERVAL_MAX = 24 * 60;

/** Scheduled backup to a git repo. Machine-specific, so these settings are never part of a dump. */
export const BackupSettings = z.object({
  backupEnabled: z.boolean(),
  /** Local clone the dump is written to and committed in. */
  backupDir: z.string().nullable(),
  /** Remote to push to (and clone from when backupDir is empty); null keeps commits local. */
  backupRemote: z.string().nullable(),
  backupIntervalMinutes: z.number().int().min(BACKUP_INTERVAL_MIN).max(BACKUP_INTERVAL_MAX),
  /** This machine's folder in the backup repo: the name set in Settings, else one made from the host name. */
  machineName: z.string(),
  /** Whether machineName is the host name's default (nothing set). */
  machineNameIsDefault: z.boolean(),
});
export type BackupSettings = z.infer<typeof BackupSettings>;

/** The last scheduled (or manual) backup run. Times are ISO strings; null means never. */
export const BackupStatus = z.object({
  running: z.boolean(),
  lastRunAt: z.string().nullable(),
  /** When a commit was last made (runs with no changes don't commit). */
  lastCommitAt: z.string().nullable(),
  lastCommit: z.string().nullable(),
  lastPushAt: z.string().nullable(),
  /** Set when the last run failed or could not push; cleared by the next clean run. */
  lastError: z.string().nullable(),
});
export type BackupStatus = z.infer<typeof BackupStatus>;

/** A machine folder in the backup repo (`GET /api/backup/machines`). */
export const BackupMachine = z.object({
  folder: z.string(),
  /** The board that owns the folder; null for a backup made before machine folders. */
  instanceId: z.string().nullable(),
  machineName: z.string().nullable(),
  /** Whether it is this board's folder. */
  current: z.boolean(),
  /** When a commit last touched the folder, as of the clone's last pull; null before its first commit. */
  lastCommitAt: z.string().nullable(),
});
export type BackupMachine = z.infer<typeof BackupMachine>;

/** What the backup setup dialog starts from (`GET /api/backup/setup-info`). */
export const BackupSetupInfo = z.object({
  gh: z.object({
    /** Whether the `gh` CLI is installed. */
    available: z.boolean(),
    /** Signed in to github.com, so it can create a repo. */
    signedIn: z.boolean(),
    /** The github.com account it is signed in as; null when signed out or when gh is too old to say. */
    login: z.string().nullable(),
  }),
  /** `<data dir>/backup`, offered when no folder is set. */
  defaultDir: z.string(),
  backupDir: z.string().nullable(),
  backupRemote: z.string().nullable(),
  machineName: z.string(),
  machineNameIsDefault: z.boolean(),
  /** The repo name the dialog offers to create: `<product id>-backup`. */
  suggestedRepoName: z.string(),
});
export type BackupSetupInfo = z.infer<typeof BackupSetupInfo>;

/** A GitHub repository name: what `gh repo create` accepts without changing it. */
export const GithubRepoName = z
  .string()
  .trim()
  .min(1, "Give the repo a name")
  .max(100, "At most 100 characters")
  .regex(/^[A-Za-z0-9._-]+$/, "Use letters, digits, '.', '_' or '-'")
  .refine((name) => name !== "." && name !== "..", "Choose another name");

/** `POST /api/backup/github-repo`: a new private repo on the account gh is signed in as. */
export const CreateBackupRepoInput = z.object({ name: GithubRepoName });
export type CreateBackupRepoInput = z.infer<typeof CreateBackupRepoInput>;

export const CreateBackupRepoResult = z.object({
  /** What to clone and push to: `https://github.com/<owner>/<name>.git`. */
  remote: z.string(),
  /** The repo's page. */
  url: z.string(),
});
export type CreateBackupRepoResult = z.infer<typeof CreateBackupRepoResult>;

/** `POST /api/backup/check-remote`: whether this machine's git can reach a remote, and what it holds. */
export const CheckBackupRemoteInput = z.object({
  remote: z
    .string()
    .trim()
    .min(1, "Paste the repo's URL")
    // git would read it as an option.
    .refine((remote) => !remote.startsWith("-"), "That isn't a repo URL"),
});
export type CheckBackupRemoteInput = z.infer<typeof CheckBackupRemoteInput>;

export const BackupRemoteCheck = z.object({
  /**
   * reachable: git can read it. auth_failed: git has no working sign-in for it. not_found: no such repo (GitHub also
   * says this for a private repo the signed-in account can't see). error: anything else, such as being offline.
   */
  status: z.enum(["reachable", "auth_failed", "not_found", "error"]),
  /** git's own message when it isn't reachable. */
  message: z.string().nullable(),
  /** What a reachable repo holds: nothing yet, a backup of ours, or something else the board won't write into. */
  content: z.enum(["empty", "backup", "other"]).nullable(),
  /** The machine folders already in a backup repo (their lastCommitAt is null: only the latest commit is read). */
  machines: z.array(BackupMachine),
});
export type BackupRemoteCheck = z.infer<typeof BackupRemoteCheck>;
