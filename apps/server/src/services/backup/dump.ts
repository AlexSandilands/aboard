import {
  BACKUP_FORMAT_VERSION,
  BRAND,
  TASK_BUNDLE_TABLES,
  type BackupRow,
  type BoardDump,
  type TaskBundle,
} from "@repo/contracts";
import { schemaVersion, transaction, type Db } from "../../db/database.ts";
import { EXPORTED_SETTINGS } from "../settings.ts";

/**
 * Columns left out of a dump. A link's snapshot is a cache the GitHub and T3 pollers rewrite on every poll; dumping
 * it would make every scheduled backup a commit. The pollers refill it after a restore.
 */
const EXCLUDED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  task_links: ["snapshot_json", "synced_at"],
};

/** Per-task rows, each in a stable order that also reads naturally (plan order, round order). */
const TASK_ROWS_SQL: Record<(typeof TASK_BUNDLE_TABLES)[number], string> = {
  plan_phases: "SELECT * FROM plan_phases ORDER BY task_id, position, id",
  plan_steps:
    "SELECT s.* FROM plan_steps s JOIN plan_phases p ON p.id = s.phase_id ORDER BY s.task_id, p.position, p.id, s.position, s.id",
  task_links: "SELECT * FROM task_links ORDER BY task_id, created_at, id",
  task_labels: "SELECT * FROM task_labels ORDER BY task_id, label",
  task_reviews: "SELECT * FROM task_reviews ORDER BY task_id, round",
  review_findings:
    "SELECT f.* FROM review_findings f JOIN task_reviews r ON r.id = f.review_id ORDER BY f.task_id, r.round, f.position",
};

const rowsOf = (db: Db, table: string, sql: string): BackupRow[] => {
  const excluded = EXCLUDED_COLUMNS[table] ?? [];
  return (db.prepare(sql).all() as BackupRow[]).map((row) =>
    excluded.length === 0 ? { ...row } : Object.fromEntries(Object.entries(row).filter(([k]) => !excluded.includes(k))),
  );
};

/** Reads the whole board in one transaction, so the dump is a consistent snapshot. */
export function dumpBoard(db: Db): BoardDump {
  return transaction(db, () => {
    const settings = rowsOf(db, "settings", "SELECT * FROM settings ORDER BY key").filter((r) =>
      EXPORTED_SETTINGS.has(String(r.key)),
    );
    const projects = rowsOf(db, "projects", "SELECT * FROM projects ORDER BY id");
    const labelColors = rowsOf(db, "label_colors", "SELECT * FROM label_colors ORDER BY label");
    const counters = rowsOf(db, "counters", "SELECT * FROM counters ORDER BY name");
    const relations = rowsOf(db, "task_relations", "SELECT * FROM task_relations ORDER BY blocker_id, blocked_id");
    const tasks = rowsOf(db, "tasks", "SELECT * FROM tasks ORDER BY number");
    const events = rowsOf(db, "task_events", "SELECT * FROM task_events ORDER BY id");

    const bundles = new Map<string, TaskBundle>(
      tasks.map((task) => [
        String(task.id),
        {
          task,
          plan_phases: [],
          plan_steps: [],
          task_links: [],
          task_labels: [],
          task_reviews: [],
          review_findings: [],
        },
      ]),
    );
    const counts: Record<string, number> = {
      settings: settings.length,
      projects: projects.length,
      label_colors: labelColors.length,
      counters: counters.length,
      task_relations: relations.length,
      tasks: tasks.length,
      task_events: events.length,
    };
    for (const table of TASK_BUNDLE_TABLES) {
      const rows = rowsOf(db, table, TASK_ROWS_SQL[table]);
      counts[table] = rows.length;
      for (const row of rows) bundles.get(String(row.task_id))![table].push(row);
    }

    return {
      manifest: {
        format: BACKUP_FORMAT_VERSION,
        app: BRAND.id,
        appVersion: BRAND.version,
        schemaVersion: schemaVersion(db),
        counts: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))),
      },
      settings,
      projects,
      label_colors: labelColors,
      counters,
      task_relations: relations,
      tasks: [...bundles.values()],
      task_events: events,
    };
  });
}
