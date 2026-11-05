-- Moving tasks between machines through the git backup repo (docs/features/backup.md#moving-tasks-between-machines).
-- The moves this board made: tasks it took from another machine's folder. The backup writes them to this machine's
-- transfers.json, where the machine they came from reads them and archives its copy.
CREATE TABLE task_transfers (
  transfer_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  -- The machine folder the task was taken from, and the board that owned it then.
  from_machine TEXT NOT NULL,
  from_instance_id TEXT,
  from_number INTEGER NOT NULL,
  -- The task's updated_at in that backup, so the source can tell it changed after the backup it was taken from.
  source_updated_at TEXT NOT NULL,
  to_machine TEXT NOT NULL,
  to_instance_id TEXT NOT NULL,
  to_number INTEGER NOT NULL,
  at TEXT NOT NULL
);
-- Other boards' moves of this board's tasks that it has acted on, so each is applied once however it arrives.
CREATE TABLE applied_transfers (
  transfer_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  -- archived: this board archived its copy. skipped: nothing to do (no such task, or it came back here since).
  outcome TEXT NOT NULL CHECK (outcome IN ('archived', 'skipped')),
  applied_at TEXT NOT NULL
);
-- Where an archived task was moved to: {"machine": "laptop", "number": 57, "at": "..."}. Null otherwise.
ALTER TABLE tasks ADD COLUMN moved_to_json TEXT;
