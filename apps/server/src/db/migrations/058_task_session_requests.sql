-- Task sessions (docs/features/autopilot.md#task-sessions): Orchestrate's requests for a new agent session on a task,
-- each made by start_task_session and taken up by the Task sessions automation as one Autopilot run. Kept, not
-- deleted, once taken up or dropped: the tool refuses a second session on a task within the hour, and reads that here.
-- History, so backups leave it out; a deleted task takes its requests with it.
CREATE TABLE task_session_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  -- What Orchestrate tells the session to do, as it wrote it.
  note TEXT NOT NULL,
  -- Who asked: the Orchestrate run's actor.
  actor TEXT NOT NULL,
  -- The Orchestrate run that asked, when the request came from one.
  requested_by_run_id TEXT,
  created_at TEXT NOT NULL,
  -- The Task sessions run that took it up last (a retried run's request is taken up again); NULL while it waits.
  run_id TEXT,
  -- Set when it was dropped without a run (the task moved on, Orchestrate was switched off, it waited too long).
  dropped_at TEXT,
  dropped_reason TEXT
);
CREATE INDEX idx_task_session_requests_task ON task_session_requests (task_id, created_at);
CREATE INDEX idx_task_session_requests_open ON task_session_requests (created_at) WHERE dropped_at IS NULL;
