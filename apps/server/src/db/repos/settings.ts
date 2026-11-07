import type { Sql } from "./sql.ts";

/** Key/value JSON settings. */
export function createSettingsRepo(sql: Sql) {
  return {
    all(): Map<string, unknown> {
      const rows = sql.all<{ key: string; value_json: string }>("SELECT key, value_json FROM settings");
      return new Map(rows.map((r) => [r.key, JSON.parse(r.value_json) as unknown]));
    },
    /** One setting, parsed; undefined when it isn't set. */
    get(key: string): unknown {
      const row = sql.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", key);
      return row ? (JSON.parse(row.value_json) as unknown) : undefined;
    },
    delete(key: string): void {
      sql.run("DELETE FROM settings WHERE key = ?", key);
    },
    set(key: string, value: unknown): void {
      sql.run(
        "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        key,
        JSON.stringify(value),
      );
    },
  };
}
