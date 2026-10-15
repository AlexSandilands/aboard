import { jsonList, type Sql } from "./sql.ts";

/** Typed access to task_labels and label_colors. */
export function createLabelsRepo(sql: Sql) {
  return {
    /** Labels per task, each list sorted by name. */
    forTasks(taskIds: readonly string[]): Map<string, string[]> {
      const rows = sql.all<{ task_id: string; label: string }>(
        "SELECT task_id, label FROM task_labels WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY label",
        jsonList(taskIds),
      );
      const map = new Map<string, string[]>();
      for (const row of rows) {
        const list = map.get(row.task_id);
        if (list) list.push(row.label);
        else map.set(row.task_id, [row.label]);
      }
      return map;
    },
    /** Replaces a task's labels. */
    replace(taskId: string, labels: readonly string[]): void {
      sql.run("DELETE FROM task_labels WHERE task_id = ?", taskId);
      for (const label of labels) sql.run("INSERT INTO task_labels (task_id, label) VALUES (?, ?)", taskId, label);
    },
    /** Labels on non-archived tasks of non-archived projects, with how many tasks carry each, by name. */
    usage(): Array<{ name: string; count: number }> {
      return sql.all<{ name: string; count: number }>(
        `SELECT l.label AS name, COUNT(*) AS count FROM task_labels l
         JOIN tasks t ON t.id = l.task_id JOIN projects p ON p.id = t.project_id
         WHERE t.archived_at IS NULL AND p.archived_at IS NULL
         GROUP BY l.label ORDER BY l.label`,
      );
    },
    colors(): Record<string, number> {
      const rows = sql.all<{ label: string; hue: number }>("SELECT label, hue FROM label_colors ORDER BY label");
      return Object.fromEntries(rows.map((r) => [r.label, r.hue]));
    },
    setColor(label: string, hue: number): void {
      sql.run(
        "INSERT INTO label_colors (label, hue) VALUES (?, ?) ON CONFLICT (label) DO UPDATE SET hue = excluded.hue",
        label,
        hue,
      );
    },
    /** True when an override was removed. */
    clearColor(label: string): boolean {
      return Number(sql.run("DELETE FROM label_colors WHERE label = ?", label).changes) > 0;
    },
  };
}
