-- Images pasted into a task's text. The file is on disk (<data dir>/attachments/<task id>/<id>.<ext>); this row
-- says what it is. task_id is null while the image was pasted into a task that isn't created yet; creating the
-- task claims the images its text refers to, and the rest are swept out after a day.
CREATE TABLE task_attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX task_attachments_task ON task_attachments (task_id);
