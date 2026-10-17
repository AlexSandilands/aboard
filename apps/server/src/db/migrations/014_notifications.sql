-- The attention inbox (docs/features/notifications.md): one row per state change worth telling the user about.
-- History only: not backed up, and pruned after 30 days.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  -- Null for a notification that isn't about one task (a digest).
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  -- Changes exactly when the state does, so a repeated observation of the same state adds nothing.
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX notifications_created ON notifications (created_at);
CREATE INDEX notifications_unread ON notifications (created_at) WHERE read_at IS NULL;
CREATE INDEX notifications_task ON notifications (task_id) WHERE task_id IS NOT NULL;
