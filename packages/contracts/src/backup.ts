import { GitHostKind } from "./gitHosts.ts";
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
  /** Tasks this board moved in from other machines (`transfers.json`, read by them). Dumps from before have none. */
  task_transfers: z.array(BackupRow).default([]),
  /** Other boards' moves of this board's tasks it has acted on. Dumps from before moves have none. */
  applied_transfers: z.array(BackupRow).default([]),
  tasks: z.array(TaskBundle),
  task_events: z.array(BackupRow),
  /**
   * Token usage read from agent sessions, with the cursors that say how far each file was read and the sessions behind
   * T3 threads. Kept because the session files don't last; restored together so a later read doesn't count it again.
   * Dumps taken before token tracking have none.
   */
  session_usage: z.array(BackupRow).default([]),
  session_usage_cursor: z.array(BackupRow).default([]),
  session_usage_thread: z.array(BackupRow).default([]),
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

/** A commit of the backup repo that touched a machine's folder (`GET /api/backup/history`). */
export const BackupCommit = z.object({
  commit: z.string(),
  shortCommit: z.string(),
  committedAt: z.string(),
  subject: z.string(),
});
export type BackupCommit = z.infer<typeof BackupCommit>;

/** A task in a backup that the board doesn't have (`missing`), or has with other contents (`changed`). */
export const BackupDiffTask = z.object({
  /** Its number in the backup, which a restore takes unless another task holds it by now. */
  number: z.number(),
  taskId: z.string(),
  title: z.string(),
  status: z.string(),
  kind: z.string(),
  projectName: z.string().nullable(),
  /** A task can only come back into a project that is on the board. */
  projectOnBoard: z.boolean(),
  change: z.enum(["missing", "changed"]),
});
export type BackupDiffTask = z.infer<typeof BackupDiffTask>;

/** How a commit's backup of a machine differs from the board (`GET /api/backup/diff`). */
export const BackupDiff = z.object({
  commit: z.string(),
  folder: z.string(),
  /** Whether the folder is another machine's, so restoring the whole board asks whether to take it over. */
  otherMachine: z.boolean(),
  /** Tasks in the backup and on the board, missing ones and changed ones. */
  counts: z.object({ backup: z.number(), board: z.number(), missing: z.number(), changed: z.number() }),
  tasks: z.array(BackupDiffTask),
});
export type BackupDiff = z.infer<typeof BackupDiff>;

/** Which backup to restore from: a commit of the backup repo (default HEAD) and a machine's folder (default ours). */
export const BackupSource = z.object({
  commit: z.string().min(1).optional(),
  machine: z.string().min(1).optional(),
});
export type BackupSource = z.infer<typeof BackupSource>;

export const RestoreTasksInput = BackupSource.extend({
  numbers: z.array(z.number().int().positive()).min(1),
  /** Replace tasks that are still on the board. */
  force: z.boolean().optional(),
});
export type RestoreTasksInput = z.infer<typeof RestoreTasksInput>;

export const RestoreTasksResult = z.object({
  results: z.array(
    z.object({
      /** The task's number in the backup. */
      number: z.number(),
      ok: z.boolean(),
      /** Its number on the board, when it restored. */
      boardNumber: z.number().nullable(),
      error: z.string().nullable(),
    }),
  ),
});
export type RestoreTasksResult = z.infer<typeof RestoreTasksResult>;

/** The word typed to confirm replacing the whole board. */
export const RESTORE_CONFIRM_WORD = "RESTORE";

export const RestoreBoardInput = BackupSource.extend({
  confirm: z.literal(RESTORE_CONFIRM_WORD),
  /**
   * Needed when the folder is another machine's: `take-over` makes it this machine's folder (new hardware, same
   * board); `new-board` keeps backing up to this machine's own folder.
   */
  otherMachine: z.enum(["take-over", "new-board"]).optional(),
});
export type RestoreBoardInput = z.infer<typeof RestoreBoardInput>;

export const RestoreBoardResult = z.object({
  counts: z.record(z.string(), z.number()),
  /** The copy of the board as it was before the restore, beside the database; null for an in-memory one. */
  safetyCopy: z.string().nullable(),
  /** The machine folder this machine backs up to from now on, when it took one over. */
  tookOver: z.string().nullable(),
});
export type RestoreBoardResult = z.infer<typeof RestoreBoardResult>;
/** What the backup setup dialog starts from (`GET /api/backup/setup-info`). */
export const BackupSetupInfo = z.object({
  /** The git host a new backup repo is made on, and whether its CLI can make one. */
  host: z.object({
    kind: GitHostKind,
    /** Whether the host's CLI (gh) is installed. */
    available: z.boolean(),
    /** Signed in to the host's main site (github.com), so it can create a repo. */
    signedIn: z.boolean(),
    /** The account it is signed in as; null when signed out or when the CLI is too old to say. */
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

// Moving tasks between machines (docs/features/backup.md#moving-tasks-between-machines). The board that takes a task
// records a transfer; its backup writes it to its machine folder's transfers.json, and the machine the task came from
// reads it there after its next pull and archives its copy (applyTransfer). Copies record nothing.

/** One move of a task from one board to another: a row of `task_transfers`, in camelCase. */
export const TaskTransfer = z.object({
  transferId: z.string().min(1),
  taskId: z.string().min(1),
  /** The machine folder the task was taken from. */
  from: z.string(),
  /** The board that owned that folder, which archives its copy; null for a folder no board has claimed. */
  fromInstanceId: z.string().nullable(),
  fromNumber: z.number().int(),
  /** The task's updatedAt in the backup it was taken from: a later one on the source means it changed since. */
  sourceUpdatedAt: z.string(),
  toMachine: z.string(),
  toInstanceId: z.string(),
  toNumber: z.number().int(),
  at: z.string(),
});
export type TaskTransfer = z.infer<typeof TaskTransfer>;

/** A transfer as a `task_transfers` row (what transfers.json holds). */
export const transferRow = (t: TaskTransfer): BackupRow => ({
  transfer_id: t.transferId,
  task_id: t.taskId,
  from_machine: t.from,
  from_instance_id: t.fromInstanceId,
  from_number: t.fromNumber,
  source_updated_at: t.sourceUpdatedAt,
  to_machine: t.toMachine,
  to_instance_id: t.toInstanceId,
  to_number: t.toNumber,
  at: t.at,
});

/** A `task_transfers` row (from a database or another machine's transfers.json) as a transfer; null if malformed. */
export function transferFromRow(row: BackupRow): TaskTransfer | null {
  const parsed = TaskTransfer.safeParse({
    transferId: row.transfer_id,
    taskId: row.task_id,
    from: row.from_machine,
    fromInstanceId: row.from_instance_id ?? null,
    fromNumber: row.from_number,
    sourceUpdatedAt: row.source_updated_at,
    toMachine: row.to_machine,
    toInstanceId: row.to_instance_id,
    toNumber: row.to_number,
    at: row.at,
  });
  return parsed.success ? parsed.data : null;
}

export const TransferMode = z.enum(["move", "copy"]);
export type TransferMode = z.infer<typeof TransferMode>;

/** How a project in another machine's backup maps onto this board: how it was matched, or null for "you pick". */
export const ImportProject = z.object({
  /** The project's id in the backup. */
  id: z.string(),
  title: z.string(),
  /** Its repo's origin, as that machine last saw it; null when it has none (or the backup is older). */
  remote: z.string().nullable(),
  /** The project here its tasks go into unless another is picked; null when none matched. */
  matchId: z.string().nullable(),
  matchedBy: z.enum(["id", "remote", "name"]).nullable(),
});
export type ImportProject = z.infer<typeof ImportProject>;

/** A task in another machine's backup, offered for moving or copying here. */
export const ImportTask = z.object({
  taskId: z.string(),
  /** Its number on that machine. */
  number: z.number(),
  title: z.string(),
  status: z.string(),
  kind: z.string(),
  projectId: z.string(),
  archived: z.boolean(),
  /**
   * no: not here. here: on this board, so it can't come in again. archived: an archived copy is here (it was moved
   * away, or archived by hand), which a move or copy replaces and unarchives.
   */
  onBoard: z.enum(["no", "here", "archived"]),
  /** An agent session or Autopilot run was going on it at that machine's backup: it can be copied, not moved. */
  busy: z.boolean(),
  /** Where it went when it was already moved off that machine: move it from there instead. Null otherwise. */
  movedTo: z.object({ machine: z.string(), number: z.number() }).nullable(),
});
export type ImportTask = z.infer<typeof ImportTask>;

/** `GET /api/backup/machines/:name/tasks`: another machine's latest backup, for moving or copying its tasks here. */
export const MachineTasks = z.object({
  folder: z.string(),
  machineName: z.string().nullable(),
  /** When a commit last touched the folder, as of the clone's last pull: how old what's offered is. */
  lastCommitAt: z.string().nullable(),
  commit: z.string(),
  projects: z.array(ImportProject),
  tasks: z.array(ImportTask),
});
export type MachineTasks = z.infer<typeof MachineTasks>;

export const ImportTasksInput = z.object({
  /** The other machine's folder (or its name). */
  machine: z.string().min(1),
  taskIds: z.array(z.string().min(1)).min(1),
  mode: TransferMode,
  /** Backup project id to the id of a project here, for projects that didn't match or should go elsewhere. */
  projectMap: z.record(z.string(), z.string()).default({}),
});
export type ImportTasksInput = z.input<typeof ImportTasksInput>;

export const ImportTaskResult = z.object({
  taskId: z.string(),
  /** Its number on the other machine. */
  number: z.number(),
  title: z.string(),
  ok: z.boolean(),
  /** Its number here, when it came in. */
  boardNumber: z.number().nullable(),
  error: z.string().nullable(),
  /** Something worth saying about one that came in: a copy of a busy task, dropped links. */
  warning: z.string().nullable(),
});
export type ImportTaskResult = z.infer<typeof ImportTaskResult>;

export const ImportTasksResult = z.object({
  mode: TransferMode,
  results: z.array(ImportTaskResult),
});
export type ImportTasksResult = z.infer<typeof ImportTasksResult>;

/**
 * `machine.json` in a machine's folder: what the board's tables don't hold about that machine, rewritten by each
 * backup run. Optional: older backups have none.
 */
export const MachineInfo = z.object({
  /** Each project's repo origin (normalizeRemote), by project id, for matching projects on another machine. */
  remotes: z.record(z.string(), z.string()).default({}),
  /** Tasks with an agent session or Autopilot run going at backup time, which another machine may copy, not move. */
  busyTaskIds: z.array(z.string()).default([]),
});
export type MachineInfo = z.infer<typeof MachineInfo>;

/**
 * A git remote reduced to host and path, so the SSH and HTTPS forms of one repo match:
 * `git@github.com:me/repo.git` and `https://github.com/me/repo` are both `github.com/me/repo`.
 */
export function normalizeRemote(remote: string): string {
  let s = remote.trim();
  const scp = /^[^@/:]+@([^:/]+):(.*)$/.exec(s);
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]*@/, "");
  return s
    .replace(/:\d+(?=\/)/, "")
    .replace(/\.git\/?$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}
