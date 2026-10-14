import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.ts";

describe("migrations", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("seeds the task number counter from existing tasks", () => {
    dir = mkdtempSync(join(tmpdir(), "board-db-"));
    const path = join(dir, "board.db");
    const db = openDatabase(path);
    // Rewind to before 003 with a task already numbered 41, as an upgraded install would be.
    db.exec(`
      DROP TABLE counters;
      DELETE FROM migrations WHERE name = '003_task_number_counter.sql';
      INSERT INTO projects (id, title, position, created_at, updated_at) VALUES ('p', 'P', 'a0', '', '');
      INSERT INTO tasks (id, number, project_id, title, status, position, created_by, created_at, updated_at, status_changed_at)
        VALUES ('t', 41, 'p', 'T', 'idea', 'a0', 'user', '', '', '');
    `);
    db.close();

    const reopened = openDatabase(path);
    const row = reopened.prepare("SELECT value FROM counters WHERE name = 'task_number'").get() as { value: number };
    reopened.close();
    expect(row.value).toBe(41);
  });
});
