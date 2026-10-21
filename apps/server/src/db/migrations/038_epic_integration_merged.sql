-- When the user marked an integration epic merged into the default branch by hand (no PR to watch). Only an epic has
-- it; the epic is Done once its tasks are and its branch has merged, and this stands in for the merge. Cleared when
-- the delivery changes, or a task of the epic is open again.
ALTER TABLE tasks ADD COLUMN integration_merged_at TEXT;
-- Integration epics already Done were finished under the old rule (tasks done is enough): count them as merged, so
-- they stay Done instead of dropping back to Review the next time something re-derives them.
UPDATE tasks SET integration_merged_at = COALESCE(status_changed_at, updated_at)
  WHERE kind = 'epic' AND delivery = 'integration' AND status = 'done';
