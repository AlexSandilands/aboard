import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
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
        VALUES ('t', 41, 'p', 'T', 'backlog', 'a0', 'user', '', '', '');
    `);
    db.close();

    const reopened = openDatabase(path);
    const row = reopened.prepare("SELECT value FROM counters WHERE name = 'task_number'").get() as { value: number };
    reopened.close();
    expect(row.value).toBe(41);
  });

  it("renames the idea status to backlog without losing child rows", () => {
    dir = mkdtempSync(join(tmpdir(), "board-db-"));
    const path = join(dir, "board.db");
    // Build the database as it stood before 006, the way an upgraded install has it.
    const old = new DatabaseSync(path);
    old.exec("PRAGMA foreign_keys = ON");
    old.exec("CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const migrationsDir = fileURLToPath(new URL("./migrations/", import.meta.url));
    for (const file of readdirSync(migrationsDir).sort()) {
      if (file >= "006") break;
      old.exec(readFileSync(join(migrationsDir, file), "utf8"));
      old.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, '')").run(file);
    }
    old.exec(`
      INSERT INTO projects (id, title, position, created_at, updated_at) VALUES ('p', 'P', 'a0', '', '');
      INSERT INTO tasks (id, number, project_id, title, status, position, created_by, created_at, updated_at, status_changed_at)
        VALUES ('a', 1, 'p', 'A', 'idea', 'a0', 'user', '', '', ''),
               ('b', 2, 'p', 'B', 'done', 'a0', 'user', '', '', '');
      UPDATE tasks SET resolution = 'completed', resolved_by_task_id = 'b' WHERE id = 'a';
      INSERT INTO plan_phases (id, task_id, title, position, created_at, updated_at) VALUES ('ph', 'a', 'Ph', 'a0', '', '');
      INSERT INTO plan_steps (id, phase_id, task_id, title, status, position, updated_at) VALUES ('st', 'ph', 'a', 'St', 'todo', 'a0', '');
      INSERT INTO task_links (id, task_id, kind, url, created_at) VALUES ('l', 'a', 'url', 'https://example.com', '');
      INSERT INTO task_labels (task_id, label) VALUES ('a', 'ui');
      INSERT INTO task_reviews (id, task_id, round, cycle, status, trigger, opened_by, created_at, updated_at)
        VALUES ('r', 'a', 1, 1, 'submitted', 'manual', 'user', '', '');
      INSERT INTO review_findings (id, review_id, task_id, position, severity, title, status, created_at)
        VALUES ('f', 'r', 'a', 1, 'nit', 'F', 'open', '');
      INSERT INTO task_events (task_id, at, actor, type, payload_json) VALUES
        ('a', '', 'user', 'created', '{"status":"idea"}'),
        ('a', '', 'user', 'status_changed', '{"from":"idea","to":"planned"}'),
        ('b', '', 'user', 'closed', '{"resolution":"wont_do","from":"idea"}'),
        ('a', '', 'user', 'note', '{"text":"idea"}');
    `);
    old.close();

    const db = openDatabase(path);
    const all = (sql: string) => db.prepare(sql).all();
    expect(all("SELECT id, status, resolved_by_task_id FROM tasks ORDER BY id")).toEqual([
      { id: "a", status: "backlog", resolved_by_task_id: "b" },
      { id: "b", status: "done", resolved_by_task_id: null },
    ]);
    const children = ["plan_phases", "plan_steps", "task_links", "task_labels", "task_reviews", "review_findings"];
    expect(children.map((table) => [table, all(`SELECT * FROM ${table}`).length])).toEqual(
      children.map((table) => [table, 1]),
    );
    expect(all("SELECT payload_json FROM task_events ORDER BY id").map((r) => r.payload_json)).toEqual([
      '{"status":"backlog"}',
      '{"from":"backlog","to":"planned"}',
      '{"resolution":"wont_do","from":"backlog"}',
      '{"text":"idea"}',
    ]);
    expect(all("PRAGMA foreign_key_check")).toEqual([]);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(() => db.exec("UPDATE tasks SET status = 'idea'")).toThrow(/CHECK/);
    // Foreign keys are enforced again: deleting a task still cascades to its children.
    db.exec("DELETE FROM tasks WHERE id = 'a'");
    expect(all("SELECT * FROM plan_steps")).toEqual([]);
    db.close();
  });

  it("re-classifies stored links that now parse as GitHub-style PRs", () => {
    dir = mkdtempSync(join(tmpdir(), "board-db-"));
    const path = join(dir, "board.db");
    const db = openDatabase(path);
    db.exec(`
      DELETE FROM migrations WHERE name = '008_enterprise_pr_links';
      INSERT INTO projects (id, title, position, created_at, updated_at) VALUES ('p', 'P', 'a0', '', '');
      INSERT INTO tasks (id, number, project_id, title, status, position, created_by, created_at, updated_at, status_changed_at)
        VALUES ('t', 1, 'p', 'T', 'backlog', 'a0', 'user', '', '', '');
      INSERT INTO task_links (id, task_id, kind, url, ref_json, created_at) VALUES
        ('ghe', 't', 'url', 'https://ghe.example.com/team/svc/pull/7', NULL, ''),
        ('forced', 't', 'pr', 'https://git.example.org/a/b/pull/2/files', NULL, ''),
        ('dup-url', 't', 'url', 'https://ghe.example.com/team/svc/pull/8', NULL, ''),
        ('dup-pr', 't', 'pr', 'https://ghe.example.com/team/svc/pull/8', NULL, ''),
        ('plain', 't', 'url', 'https://example.com/docs', NULL, ''),
        ('ado', 't', 'pr', 'https://dev.azure.com/o/p/_git/r/pullrequest/3', NULL, '');
    `);
    db.close();

    const reopened = openDatabase(path);
    const rows = reopened.prepare("SELECT id, kind, ref_json FROM task_links ORDER BY id").all();
    reopened.close();
    expect(rows).toEqual([
      { id: "ado", kind: "pr", ref_json: null },
      { id: "dup-pr", kind: "pr", ref_json: '{"host":"ghe.example.com","repo":"team/svc","number":8}' },
      { id: "forced", kind: "pr", ref_json: '{"host":"git.example.org","repo":"a/b","number":2}' },
      { id: "ghe", kind: "pr", ref_json: '{"host":"ghe.example.com","repo":"team/svc","number":7}' },
      { id: "plain", kind: "url", ref_json: null },
    ]);
  });
});
