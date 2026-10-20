-- migrate: foreign_keys off
-- Ticket systems replace the built-in Jira support (docs/features/ticket-systems.md). The 'jira' link kind becomes
-- 'ticket', whose ref names the system and the key; the Jira links become tickets of a system with the id 'jira',
-- which the code migration 036_ticket_systems_settings creates from the old Jira settings. task_links also gains
-- `auto`, set on links the board added by itself rather than on request. SQLite can't change a CHECK in place, so both
-- tables are rebuilt as in 008.
CREATE TABLE task_links_new (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('pr', 'ticket', 't3_thread', 'issue', 'agent_session', 'url')),
  url TEXT NOT NULL,
  label TEXT,
  ref_json TEXT,
  snapshot_json TEXT,
  synced_at TEXT,
  created_at TEXT NOT NULL,
  pr_changes_json TEXT,
  auto INTEGER NOT NULL DEFAULT 0,
  UNIQUE (task_id, kind, url)
);

INSERT INTO task_links_new (id, task_id, kind, url, label, ref_json, snapshot_json, synced_at, created_at, pr_changes_json)
SELECT id, task_id,
       CASE kind WHEN 'jira' THEN 'ticket' ELSE kind END,
       url, label,
       CASE kind
         WHEN 'jira' THEN json_object('system', 'jira', 'key', COALESCE(json_extract(ref_json, '$.key'), url))
         ELSE ref_json
       END,
       snapshot_json, synced_at, created_at, pr_changes_json
FROM task_links;

DROP TABLE task_links;
ALTER TABLE task_links_new RENAME TO task_links;
CREATE INDEX task_links_task ON task_links (task_id);

-- An import's source is a ticket of a configured system (`system_id`) or a GitHub issue (no system).
CREATE TABLE task_imports_new (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('ticket', 'issue')),
  system_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'failed', 'done')),
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO task_imports_new (task_id, source_url, source_kind, system_id, status, error, attempts, created_at, updated_at)
SELECT task_id, source_url,
       CASE source_kind WHEN 'jira' THEN 'ticket' ELSE source_kind END,
       CASE source_kind WHEN 'jira' THEN 'jira' END,
       status, error, attempts, created_at, updated_at
FROM task_imports;

DROP TABLE task_imports;
ALTER TABLE task_imports_new RENAME TO task_imports;
CREATE INDEX task_imports_status ON task_imports (status);

-- The activity log names link kinds too.
UPDATE task_events SET payload_json = json_set(payload_json, '$.kind', 'ticket')
WHERE type IN ('link_added', 'link_removed', 'link_updated') AND json_extract(payload_json, '$.kind') = 'jira';
