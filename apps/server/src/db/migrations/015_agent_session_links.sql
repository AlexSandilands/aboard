-- migrate: foreign_keys off
-- task_links gains the 'agent_session' kind: a Claude Code or Copilot CLI session the board can show the status of
-- and resume in a terminal. SQLite can't change a CHECK in place, so the table is rebuilt as in 008.
CREATE TABLE task_links_new (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('pr', 'jira', 't3_thread', 'issue', 'agent_session', 'url')),
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
