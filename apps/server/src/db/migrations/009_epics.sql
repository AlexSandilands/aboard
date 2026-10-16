-- Epics: a task with kind 'epic' groups child tasks, which point at it with parent_id. One level only: the
-- service keeps epics from having a parent and children from being epics. Deleting an epic detaches its children.
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'epic'));
ALTER TABLE tasks ADD COLUMN parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
CREATE INDEX tasks_parent ON tasks (parent_id) WHERE parent_id IS NOT NULL;
