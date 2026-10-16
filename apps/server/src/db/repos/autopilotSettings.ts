import type { AutopilotMode, AutopilotScopeKind, AutopilotSetting } from "@repo/contracts";
import type { Sql } from "./sql.ts";

interface SettingRow {
  scope_kind: AutopilotScopeKind;
  scope_id: string;
  automation: string;
  mode: AutopilotMode;
  config_json: string;
  updated_at: string;
}

const toSetting = (r: SettingRow): AutopilotSetting => ({
  scopeKind: r.scope_kind,
  // The board scope is stored with an empty id so the primary key covers it.
  scopeId: r.scope_id === "" ? null : r.scope_id,
  automation: r.automation,
  mode: r.mode,
  config: JSON.parse(r.config_json || "{}") as Record<string, unknown>,
  updatedAt: r.updated_at,
});

/** Typed access to autopilot_settings: one automation's mode and config at one scope. */
export function createAutopilotSettingsRepo(sql: Sql) {
  return {
    all(): AutopilotSetting[] {
      return sql
        .all<SettingRow>("SELECT * FROM autopilot_settings ORDER BY scope_kind, scope_id, automation")
        .map(toSetting);
    },
    forScope(kind: AutopilotScopeKind, id: string | null): AutopilotSetting[] {
      return sql
        .all<SettingRow>(
          "SELECT * FROM autopilot_settings WHERE scope_kind = ? AND scope_id = ? ORDER BY automation",
          kind,
          id ?? "",
        )
        .map(toSetting);
    },
    upsert(s: AutopilotSetting): void {
      sql.run(
        `INSERT INTO autopilot_settings (scope_kind, scope_id, automation, mode, config_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope_kind, scope_id, automation)
         DO UPDATE SET mode = excluded.mode, config_json = excluded.config_json, updated_at = excluded.updated_at`,
        s.scopeKind,
        s.scopeId ?? "",
        s.automation,
        s.mode,
        JSON.stringify(s.config),
        s.updatedAt,
      );
    },
    delete(kind: AutopilotScopeKind, id: string | null, automation: string): void {
      sql.run(
        "DELETE FROM autopilot_settings WHERE scope_kind = ? AND scope_id = ? AND automation = ?",
        kind,
        id ?? "",
        automation,
      );
    },
  };
}
