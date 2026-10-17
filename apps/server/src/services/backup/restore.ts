import { existsSync, renameSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { BACKUP_FORMAT_VERSION, BRAND, TASK_BUNDLE_TABLES, type BackupRow, type BoardDump } from "@repo/contracts";
import { migrate, migrationNames, openDatabase, transaction, type Db } from "../../db/database.ts";
import { AppError } from "../../errors.ts";
import { EXPORTED_SETTINGS } from "../settings.ts";
import { dumpBoard } from "./dump.ts";
import { copyAttachmentFiles } from "./files.ts";

/** Restore order: parents before children (foreign keys are deferred anyway, but this reads as the schema does). */
const TABLES = [
  "settings",
  "projects",
  "label_colors",
  "counters",
  "task_templates",
  "task_relations",
  "tasks",
  // After tasks: an epic scope points at one.
  "autopilot_settings",
  // After tasks too: a rule remembers the last task it made.
  "autopilot_recurring",
  // After autopilot_settings, so clearing it (whose trigger deletes its switches) comes first.
  "autopilot_custom",
  ...TASK_BUNDLE_TABLES,
  "task_events",
] as const;
type Table = (typeof TABLES)[number];

const rowsByTable = (dump: BoardDump): Record<Table, BackupRow[]> => ({
  settings: dump.settings.filter((r) => EXPORTED_SETTINGS.has(String(r.key))),
  projects: dump.projects,
  label_colors: dump.label_colors,
  counters: dump.counters,
  task_templates: dump.task_templates,
  task_relations: dump.task_relations,
  tasks: dump.tasks.map((b) => b.task),
  autopilot_settings: dump.autopilot_settings,
  autopilot_recurring: dump.autopilot_recurring,
  autopilot_custom: dump.autopilot_custom,
  plan_phases: dump.tasks.flatMap((b) => b.plan_phases),
  plan_steps: dump.tasks.flatMap((b) => b.plan_steps),
  task_links: dump.tasks.flatMap((b) => b.task_links),
  task_attachments: dump.tasks.flatMap((b) => b.task_attachments),
  task_labels: dump.tasks.flatMap((b) => b.task_labels),
  task_reviews: dump.tasks.flatMap((b) => b.task_reviews),
  review_findings: dump.tasks.flatMap((b) => b.review_findings),
  task_events: dump.task_events,
});

/** Rejects dumps this server can't load: another app's, an unknown layout, or a schema newer than ours. */
export function checkManifest(dump: BoardDump): void {
  const { manifest } = dump;
  if (manifest.app !== BRAND.id)
    throw new AppError("VALIDATION", `This backup is from ${manifest.app}, not ${BRAND.id}`);
  if (manifest.format !== BACKUP_FORMAT_VERSION) {
    throw new AppError(
      "VALIDATION",
      `Unsupported backup format ${manifest.format} (this version reads format ${BACKUP_FORMAT_VERSION})`,
    );
  }
  if (!migrationNames().includes(manifest.schemaVersion)) {
    throw new AppError(
      "VALIDATION",
      `This backup is at schema ${manifest.schemaVersion}, which this version doesn't know. Update ${BRAND.name} (backup taken by ${manifest.appVersion}).`,
    );
  }
}

/** Inserts `row` into `table`, checking its keys against the table's columns (they go into the SQL). */
export function insertRows(db: Db, table: Table, rows: readonly BackupRow[]): void {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  const statements = new Map<string, ReturnType<Db["prepare"]>>();
  for (const row of rows) {
    const keys = Object.keys(row);
    const unknown = keys.find((k) => !columns.has(k));
    if (unknown) throw new AppError("VALIDATION", `Backup has an unknown column ${table}.${unknown}`);
    const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
    let stmt = statements.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      statements.set(sql, stmt);
    }
    stmt.run(...Object.values(row));
  }
}

/**
 * Loads the dump into `db`, which must be at the dump's schema version, replacing what is there, in one
 * transaction. Before committing it checks every foreign key and that each table holds the manifest's row count;
 * on any failure nothing is written.
 */
function loadDump(db: Db, dump: BoardDump): void {
  const rows = rowsByTable(dump);
  // An older schema lacks later tables (label_colors before 005); a dump taken at it has no rows for them.
  const existing = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (t) => t.name,
    ),
  );
  const tables = TABLES.filter((table) => {
    if (existing.has(table)) return true;
    if (rows[table].length > 0)
      throw new AppError("VALIDATION", `Backup has ${table} rows, but its schema has no ${table}`);
    return false;
  });
  transaction(db, () => {
    // Rows reference each other in both directions (tasks closed against tasks); check them all at COMMIT.
    db.exec("PRAGMA defer_foreign_keys = ON");
    // A fresh database isn't quite empty: migrations seed some rows (the task number counter).
    for (const table of [...tables].reverse()) db.exec(`DELETE FROM ${table}`);
    for (const table of tables) insertRows(db, table, rows[table]);

    const broken = db.prepare("PRAGMA foreign_key_check").all();
    if (broken.length > 0) {
      throw new AppError("VALIDATION", `The backup has ${broken.length} broken reference(s)`, broken.slice(0, 10));
    }
    for (const [table, expected] of Object.entries(dump.manifest.counts)) {
      if (!(tables as readonly string[]).includes(table)) continue;
      const { n } = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
      if (n !== expected) {
        throw new AppError("VALIDATION", `Restored ${n} ${table} row(s) but the backup's manifest lists ${expected}`);
      }
    }
  });
}

/** The dump at this server's schema: an older dump is loaded into a scratch database, migrated and dumped again. */
export function upgradeDump(dump: BoardDump): BoardDump {
  checkManifest(dump);
  if (dump.manifest.schemaVersion === migrationNames().at(-1)) return dump;
  const db = openDatabase(":memory:", { migrateTo: dump.manifest.schemaVersion });
  try {
    loadDump(db, dump);
    migrate(db);
    return dumpBoard(db);
  } finally {
    db.close();
  }
}

/** Whether the database at `path` holds a board (any project or task). Unreadable counts as not empty. */
function hasBoard(path: string): boolean {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (t) => t.name,
      ),
    );
    return ["projects", "tasks"].some(
      (t) => tables.has(t) && db!.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get() !== undefined,
    );
  } catch {
    return true;
  } finally {
    db?.close();
  }
}

/** Settings that never go into a dump (the T3 token, the backup setup), read from the database being replaced. */
function machineSettings(path: string): BackupRow[] {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    return (db.prepare("SELECT key, value_json FROM settings ORDER BY key").all() as BackupRow[]).filter(
      (r) => !EXPORTED_SETTINGS.has(String(r.key)),
    );
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

const SQLITE_SIDE_FILES = ["", "-wal", "-shm"];

export interface RestoreResult {
  counts: Record<string, number>;
  schemaVersion: string;
  /** Where the database the restore replaced was moved to, if there was one. */
  previousDb: string | null;
  /** Pasted images copied back, and those the backup has rows for but no file (a single-file dump has none). */
  attachments: { copied: number; missing: number };
}

export interface RestoreOptions {
  force?: boolean;
  /** The backup folder the dump was read from, and the data dir's attachments folder to copy its images into. */
  attachments?: { from: string | null; to: string };
}

/**
 * Restores a whole board into the database file at `dbPath`. The dump is loaded into a new file at the dump's
 * schema version, verified, migrated to the latest schema, and only then swapped in; the old file is kept beside
 * it (`.before-restore-<time>`). Refuses to replace a board unless `force` is set. The caller makes sure no server
 * has the database open.
 */
export function restoreBoard(dbPath: string, dump: BoardDump, options: RestoreOptions = {}): RestoreResult {
  checkManifest(dump);
  const exists = existsSync(dbPath);
  if (exists && !options.force && hasBoard(dbPath)) {
    throw new AppError("CONFLICT", `${dbPath} already holds a board. Restore with --force to replace it.`);
  }
  const kept = exists ? machineSettings(dbPath) : [];

  const tmpPath = `${dbPath}.restoring`;
  const removeTmp = () => {
    for (const suffix of SQLITE_SIDE_FILES) rmSync(tmpPath + suffix, { force: true });
  };
  removeTmp();
  const db = openDatabase(tmpPath, { migrateTo: dump.manifest.schemaVersion });
  try {
    loadDump(db, dump);
    migrate(db);
    transaction(db, () => insertRows(db, "settings", kept));
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (error) {
    db.close();
    removeTmp();
    throw error;
  }
  db.close();

  let previousDb: string | null = null;
  if (exists) {
    previousDb = `${dbPath}.before-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    for (const suffix of SQLITE_SIDE_FILES) {
      if (existsSync(dbPath + suffix)) renameSync(dbPath + suffix, previousDb + suffix);
    }
  }
  renameSync(tmpPath, dbPath);
  removeTmp();
  const attachments = options.attachments
    ? copyAttachmentFiles(
        dump.tasks.flatMap((b) => b.task_attachments),
        options.attachments.from,
        options.attachments.to,
      )
    : { copied: 0, missing: 0 };
  return { counts: dump.manifest.counts, schemaVersion: dump.manifest.schemaVersion, previousDb, attachments };
}
