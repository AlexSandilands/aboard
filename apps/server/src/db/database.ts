import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export type Db = DatabaseSync;

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

/** Opens (or creates) the database at `path` (":memory:" for tests) and applies pending migrations. */
export function openDatabase(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(
    (db.prepare("SELECT name FROM migrations").all() as Array<{ name: string }>).map((r) => r.name),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(MIGRATIONS_DIR + file, "utf8");
    // Rebuilding a table (SQLite's 12-step ALTER) drops it, which with foreign keys on would cascade-delete
    // every child row. Such a migration marks itself and runs with them off; the pragma is a no-op inside a
    // transaction, so it is set around it, and foreign_key_check stands in for the checks we skipped.
    const foreignKeysOff = sql.startsWith(FOREIGN_KEYS_OFF);
    if (foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");
    try {
      transaction(db, () => {
        db.exec(sql);
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
