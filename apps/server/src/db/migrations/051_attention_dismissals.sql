-- Attention flags the user dismissed on a task (docs/features/notifications.md#dismissing-a-flag). `key` says what
-- raised the flag and `fingerprint` the state that raised it (see deriveAttention); a row hides its flag only while
-- the flag's fingerprint is still this one, so a new failure shows again. Rows that match nothing are ignored, and
-- a later dismissal of the same key replaces the row, so nothing is pruned.
CREATE TABLE attention_dismissals (
  task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  actor TEXT NOT NULL,
  dismissed_at TEXT NOT NULL,
  PRIMARY KEY (task_id, key)
);
