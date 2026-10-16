import { z } from "zod";

// A backup is the board's tables written out as JSON, one file per task, so it diffs well in git. Rows keep the
// database's own column names: a dump is restored into a database migrated to the dump's schema version, so the
// columns always line up, and a newer server migrates the rows forward afterwards (see docs/features/backup.md).

/** Bumped when the layout of the dump (files, keys) changes, not when the schema does. */
export const BACKUP_FORMAT_VERSION = 1;

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
});
export type BackupManifest = z.infer<typeof BackupManifest>;

/** Tables whose rows belong to one task, in the order they are inserted. */
export const TASK_BUNDLE_TABLES = [
  "plan_phases",
  "plan_steps",
  "task_links",
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
  /** Autopilot switches and config per scope. Dumps taken before Autopilot have none. */
  autopilot_settings: z.array(BackupRow).default([]),
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
