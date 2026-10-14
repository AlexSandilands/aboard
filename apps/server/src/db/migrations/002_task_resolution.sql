ALTER TABLE tasks ADD COLUMN resolution TEXT CHECK (resolution IN ('completed', 'duplicate', 'wont_do'));
ALTER TABLE tasks ADD COLUMN resolved_by_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
CREATE INDEX tasks_resolved_by ON tasks (resolved_by_task_id) WHERE resolved_by_task_id IS NOT NULL;
