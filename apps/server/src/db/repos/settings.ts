import type { Sql } from "./sql.ts";

/** Key/value JSON settings. */
export function createSettingsRepo(sql: Sql) {
  return {
    all(): Map<string, unknown> {
      const rows = sql.all<{ key: string; value_json: string }>("SELECT key, value_json FROM settings");
      return new Map(rows.map((r) => [r.key, JSON.parse(r.value_json) as unknown]));
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
