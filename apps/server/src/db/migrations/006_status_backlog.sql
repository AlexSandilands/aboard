-- migrate: foreign_keys off
-- The first column is now Backlog: the "idea" status becomes "backlog". SQLite can't change a CHECK in
-- place, so tasks is rebuilt (create, copy, drop, rename). The runner turns foreign keys off for this file
-- so dropping tasks doesn't cascade to its children, and runs foreign_key_check before committing.
CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  plan_context TEXT,
  status TEXT NOT NULL CHECK (status IN ('backlog', 'planned', 'in_progress', 'review', 'done')),
  position TEXT NOT NULL,
  archived_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  resolution TEXT CHECK (resolution IN ('completed', 'duplicate', 'wont_do')),
  resolved_by_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  auto_review INTEGER CHECK (auto_review IN (0, 1))
);

INSERT INTO tasks_new (
  id, number, project_id, title, description, plan_context, status, position, archived_at, created_by,
  created_at, updated_at, status_changed_at, resolution, resolved_by_task_id, auto_review
)
SELECT
  id, number, project_id, title, description, plan_context,
  CASE status WHEN 'idea' THEN 'backlog' ELSE status END,
  position, archived_at, created_by, created_at, updated_at, status_changed_at, resolution,
  resolved_by_task_id, auto_review
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX tasks_lane ON tasks (project_id, status, position);
CREATE INDEX tasks_resolved_by ON tasks (resolved_by_task_id) WHERE resolved_by_task_id IS NOT NULL;

-- The activity log shows statuses from event payloads ("created", "status_changed", "closed").
UPDATE task_events SET payload_json = json_set(payload_json, '$.status', 'backlog')
  WHERE type IN ('created', 'status_changed', 'closed') AND json_extract(payload_json, '$.status') = 'idea';
UPDATE task_events SET payload_json = json_set(payload_json, '$.from', 'backlog')
  WHERE type IN ('created', 'status_changed', 'closed') AND json_extract(payload_json, '$.from') = 'idea';
UPDATE task_events SET payload_json = json_set(payload_json, '$.to', 'backlog')
  WHERE type IN ('created', 'status_changed', 'closed') AND json_extract(payload_json, '$.to') = 'idea';
