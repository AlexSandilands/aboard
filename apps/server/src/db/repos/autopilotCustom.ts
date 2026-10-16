import { CustomAction, CustomFilters, CustomTrigger, type CustomAutomation } from "@repo/contracts";
import type { Sql } from "./sql.ts";

interface CustomRow {
  id: string;
  name: string;
  trigger_json: string;
  filters_json: string;
  action_json: string;
  armed_at: string;
  created_at: string;
  updated_at: string;
}

const toCustom = (r: CustomRow): CustomAutomation => ({
  id: r.id,
  name: r.name,
  // Written through the schemas, so they parse; a hand-edited row that doesn't is a corrupt database.
  trigger: CustomTrigger.parse(JSON.parse(r.trigger_json)),
  filters: CustomFilters.parse(JSON.parse(r.filters_json)),
  action: CustomAction.parse(JSON.parse(r.action_json)),
  armedAt: r.armed_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toRow = (c: CustomAutomation) => ({
  id: c.id,
  name: c.name,
  trigger_json: JSON.stringify(c.trigger),
  filters_json: JSON.stringify(c.filters),
  action_json: JSON.stringify(c.action),
  armed_at: c.armedAt,
  created_at: c.createdAt,
  updated_at: c.updatedAt,
});

/** Typed access to autopilot_custom: the automations the user defined. */
export function createAutopilotCustomRepo(sql: Sql) {
  return {
    get(id: string): CustomAutomation | null {
      const row = sql.get<CustomRow>("SELECT * FROM autopilot_custom WHERE id = ?", id);
      return row ? toCustom(row) : null;
    },
    /** Oldest first, the order the catalogue lists them in. */
    all(): CustomAutomation[] {
      return sql.all<CustomRow>("SELECT * FROM autopilot_custom ORDER BY created_at, id").map(toCustom);
    },
    /** The automation called `name` (any case). */
    byName(name: string): CustomAutomation | null {
      const row = sql.get<CustomRow>("SELECT * FROM autopilot_custom WHERE name = ? COLLATE NOCASE", name);
      return row ? toCustom(row) : null;
    },
    insert(custom: CustomAutomation): void {
      sql.insert("autopilot_custom", toRow(custom));
    },
    update(custom: CustomAutomation): void {
      sql.update("autopilot_custom", toRow(custom));
    },
    delete(id: string): void {
      sql.run("DELETE FROM autopilot_custom WHERE id = ?", id);
    },
  };
}
