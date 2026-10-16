-- migrate: foreign_keys off
-- Tasks created from a Jira or GitHub issue: a background job fills in their title, description and labels.
-- task_links gains the 'issue' kind (a GitHub issue). SQLite can't change a CHECK in place, so it is rebuilt
-- (create, copy, drop, rename); the runner turns foreign keys off for this file and checks them before committing.
CREATE TABLE task_links_new (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('pr', 'jira', 't3_thread', 'issue', 'url')),
  url TEXT NOT NULL,
  label TEXT,
  ref_json TEXT,
  snapshot_json TEXT,
  synced_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, kind, url)
);

INSERT INTO task_links_new (id, task_id, kind, url, label, ref_json, snapshot_json, synced_at, created_at)
SELECT id, task_id, kind, url, label, ref_json, snapshot_json, synced_at, created_at FROM task_links;

DROP TABLE task_links;
ALTER TABLE task_links_new RENAME TO task_links;
CREATE INDEX task_links_task ON task_links (task_id);

-- One row per imported task; it stays after a successful import so the task keeps saying where it came from.
CREATE TABLE task_imports (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  -- What the user pasted: a Jira key or an issue URL.
  source_url TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('jira', 'issue')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'failed', 'done')),
  error TEXT,
  -- Runs started so far; a pending import interrupted by restarts gives up after a few.
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX task_imports_status ON task_imports (status);
