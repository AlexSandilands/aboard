-- The trash (docs/features/task-lifecycle.md#deleting): a deleted task keeps its row, stamped with deleted_at, and is
-- hidden everywhere until it is restored or the retention period ends and the purge removes it for good. An epic
-- deleted together with its tasks gives them the same stamp, so restoring the epic can bring back exactly those.
ALTER TABLE tasks ADD COLUMN deleted_at TEXT;
CREATE INDEX idx_tasks_deleted_at ON tasks (deleted_at) WHERE deleted_at IS NOT NULL;
