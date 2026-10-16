import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { CODE_MIGRATIONS } from "./codeMigrations.ts";

export type Db = DatabaseSync;

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

/**
 * Opens (or creates) the database at `path` (":memory:" for tests) and applies pending migrations, or only those
 * up to and including `migrateTo` (a restore loads a backup at the schema it was taken at).
 */
export function openDatabase(path: string, options: { migrateTo?: string } = {}): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db, options.migrateTo);
  return db;
}

/** Migration file names in the order they apply. */
export function migrationNames(): string[] {
  return [...readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")), ...Object.keys(CODE_MIGRATIONS)].sort();
}

/** The last migration applied: the schema version a backup records. */
export function schemaVersion(db: Db): string {
  const row = db.prepare("SELECT max(name) AS name FROM migrations").get() as { name: string | null };
  if (!row.name) throw new Error("The database has no migrations applied");
  return row.name;
}

/** Applies pending migrations, or those up to and including `upTo`. */
export function migrate(db: Db, upTo?: string): void {
  const files = migrationNames();
  if (upTo !== undefined && !files.includes(upTo)) throw new Error(`Unknown schema version ${upTo}`);
  db.exec("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(
    (db.prepare("SELECT name FROM migrations").all() as Array<{ name: string }>).map((r) => r.name),
  );
  for (const file of files) {
    if (upTo !== undefined && file > upTo) break;
    if (applied.has(file)) continue;
    const code = CODE_MIGRATIONS[file];
    const sql = code ? "" : readFileSync(MIGRATIONS_DIR + file, "utf8");
    // Rebuilding a table (SQLite's 12-step ALTER) drops it, which with foreign keys on would cascade-delete
    // every child row. Such a migration marks itself and runs with them off; the pragma is a no-op inside a
    // transaction, so it is set around it, and foreign_key_check stands in for the checks we skipped.
    const foreignKeysOff = sql.startsWith(FOREIGN_KEYS_OFF);
    if (foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");
    try {
      transaction(db, () => {
        if (code) code(db);
        else db.exec(sql);
        if (foreignKeysOff) {
          const broken = db.prepare("PRAGMA foreign_key_check").all();
          if (broken.length > 0)
            throw new Error(`${file} broke ${broken.length} foreign key(s): ${JSON.stringify(broken)}`);
        }
        db.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
      });
    } finally {
      if (foreignKeysOff) db.exec("PRAGMA foreign_keys = ON");
    }
  }
}

/** First line of a migration that must run with foreign keys off. */
const FOREIGN_KEYS_OFF = "-- migrate: foreign_keys off";

let depth = 0;

/** Runs `fn` in a transaction. Nested calls join the outer transaction. */
export function transaction<T>(db: Db, fn: () => T): T {
  if (depth > 0) return fn();
  db.exec("BEGIN IMMEDIATE");
  depth += 1;
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    depth -= 1;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- caller declares the stored JSON shape (a cast at the DB boundary)
export function parseJson<T>(value: unknown): T | null {
  if (typeof value !== "string" || value === "") return null;
  return JSON.parse(value) as T;
}
