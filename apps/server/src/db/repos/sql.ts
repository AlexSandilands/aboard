import type { SQLInputValue, StatementSync } from "node:sqlite";
import type { Db } from "../database.ts";

export type Row = Record<string, SQLInputValue>;

/** Prepared-statement helpers bound to one database (statements are cached by SQL text). */
export function createSql(db: Db) {
  const cache = new Map<string, StatementSync>();
  const prepare = (sql: string): StatementSync => {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      cache.set(sql, stmt);
    }
    return stmt;
  };
  return {
    all: <T>(sql: string, ...params: SQLInputValue[]) => prepare(sql).all(...params) as unknown as T[],
    get: <T>(sql: string, ...params: SQLInputValue[]) => prepare(sql).get(...params) as unknown as T | undefined,
    run: (sql: string, ...params: SQLInputValue[]) => prepare(sql).run(...params),
    insert(table: string, row: Row): void {
      const cols = Object.keys(row);
      prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
        ...Object.values(row),
      );
    },
    /** Updates every column of `row` (except id) on the row with the same id. */
    update(table: string, row: Row & { id: string }): void {
      const cols = Object.keys(row).filter((c) => c !== "id");
      prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(
        ...cols.map((c) => row[c] ?? null),
        row.id,
      );
    },
  };
}
export type Sql = ReturnType<typeof createSql>;

/** Binds a string list for `IN (SELECT value FROM json_each(?))`. */
export const jsonList = (ids: readonly string[]): string => JSON.stringify(ids);
