-- A GitHub milestone can be imported too: it becomes an epic and its open issues its tasks
-- (docs/features/issue-import.md#milestones). task_imports' source_kind gains 'milestone'. SQLite can't change a CHECK
-- in place, so the table is rebuilt (create, copy, drop, rename); nothing references it.
CREATE TABLE task_imports_new (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('ticket', 'issue', 'milestone')),
  system_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'failed', 'done')),
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO task_imports_new (task_id, source_url, source_kind, system_id, status, error, attempts, created_at, updated_at)
SELECT task_id, source_url, source_kind, system_id, status, error, attempts, created_at, updated_at FROM task_imports;

DROP TABLE task_imports;
ALTER TABLE task_imports_new RENAME TO task_imports;
CREATE INDEX task_imports_status ON task_imports (status);
