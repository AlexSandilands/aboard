-- migrate: foreign_keys off
-- Working copies and replay (docs/features/remote-machines.md#held-tasks).

-- A task made on a machine while the board can't be reached is numbered by the machine, with its prefix (#E7), so
-- a number is unique with its prefix, no longer by itself. That needs the table rebuilt: the old UNIQUE was the
-- column's own.
CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  -- '' for a task the board numbered; a machine's prefix otherwise. Never changes.
  number_prefix TEXT NOT NULL DEFAULT '',
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
  auto_review INTEGER CHECK (auto_review IN (0, 1)),
  suggested_tier TEXT CHECK (suggested_tier IN ('light', 'standard', 'deep')),
  suggested_reason TEXT,
  kind TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'epic')),
  parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  template_id TEXT REFERENCES task_templates(id) ON DELETE SET NULL,
  autopilot INTEGER CHECK (autopilot IN (0, 1)),
  delivery TEXT CHECK (delivery IN ('main', 'integration')),
  integration_branch TEXT,
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority IN (0, 1)),
  auto_merge INTEGER CHECK (auto_merge IN (0, 1)),
  attention_message TEXT,
  attention_actor TEXT,
  attention_requested_at TEXT,
  due_date TEXT CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  manual INTEGER NOT NULL DEFAULT 0 CHECK (manual IN (0, 1)),
  integration_merged_at TEXT,
  review_model_json TEXT,
  moved_to_json TEXT,
  deleted_at TEXT,
  UNIQUE (number_prefix, number)
);

INSERT INTO tasks_new (
  id, number, project_id, title, description, plan_context, status, position, archived_at, created_by, created_at,
  updated_at, status_changed_at, resolution, resolved_by_task_id, auto_review, suggested_tier, suggested_reason, kind,
  parent_id, template_id, autopilot, delivery, integration_branch, priority, auto_merge, attention_message,
  attention_actor, attention_requested_at, due_date, manual, integration_merged_at, review_model_json, moved_to_json,
  deleted_at
)
SELECT
  id, number, project_id, title, description, plan_context, status, position, archived_at, created_by, created_at,
  updated_at, status_changed_at, resolution, resolved_by_task_id, auto_review, suggested_tier, suggested_reason, kind,
  parent_id, template_id, autopilot, delivery, integration_branch, priority, auto_merge, attention_message,
  attention_actor, attention_requested_at, due_date, manual, integration_merged_at, review_model_json, moved_to_json,
  deleted_at
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX tasks_lane ON tasks (project_id, status, position);
CREATE INDEX tasks_resolved_by ON tasks (resolved_by_task_id) WHERE resolved_by_task_id IS NOT NULL;
CREATE INDEX tasks_parent ON tasks (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX idx_tasks_deleted_at ON tasks (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE TRIGGER autopilot_settings_epic_deleted AFTER DELETE ON tasks BEGIN
  DELETE FROM autopilot_settings WHERE scope_kind = 'epic' AND scope_id = OLD.id;
END;

-- ── On a board ─────────────────────────────────────────────────────────────────────────────────────────────────
-- None of these is part of a backup: which machine holds what belongs to this board and that machine.

-- The machine a task is handed to. While a row stands, that machine orders every change to the task.
CREATE TABLE task_holds (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  held_at TEXT NOT NULL
);
CREATE INDEX task_holds_machine ON task_holds (machine_id);

-- How far the board has applied each machine's change log. `epoch` names the log the position belongs to.
CREATE TABLE machine_sync (
  machine_id TEXT PRIMARY KEY REFERENCES machines(id) ON DELETE CASCADE,
  epoch TEXT,
  applied_log_id INTEGER NOT NULL DEFAULT 0
);

-- Edits made on the board to a held task that its machine hasn't taken yet, in the order they were made. The board
-- shows them already; `event_ids_json` lists the activity entries it wrote for them, which the machine's own replace.
CREATE TABLE held_edits (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  op TEXT NOT NULL,
  args_json TEXT NOT NULL,
  ids_json TEXT NOT NULL DEFAULT '[]',
  references_json TEXT NOT NULL DEFAULT '[]',
  event_ids_json TEXT NOT NULL DEFAULT '[]',
  -- The machine's log position that carries the edit's outcome, once it has answered; NULL while the edit waits.
  settled_head INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX held_edits_task ON held_edits (task_id);

-- ── On a runner ────────────────────────────────────────────────────────────────────────────────────────────────

-- What each task row on a runner is: one it holds for the board, or one a held task only points at.
CREATE TABLE working_copies (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('held', 'reference')),
  -- The last activity entry already sent in a log entry.
  last_event_id INTEGER NOT NULL DEFAULT 0,
  -- The state last logged, so a write that changed nothing logs nothing.
  logged_state TEXT,
  created_at TEXT NOT NULL
);

-- Every change to a held task, in order. Entries the board has applied are dropped.
CREATE TABLE change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  task_id TEXT NOT NULL,
  at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

-- What maps a runner's project to the board's: the board's id for it once the board has named it, and the
-- repository it is, by its remote.
CREATE TABLE copied_projects (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  board_id TEXT,
  remote TEXT,
  remote_url TEXT
);

-- The board's edits a runner has dealt with, so one sent twice is applied once.
CREATE TABLE applied_edits (
  id TEXT PRIMARY KEY,
  applied INTEGER NOT NULL,
  error TEXT,
  head INTEGER NOT NULL,
  at TEXT NOT NULL
);

-- A runner's own facts: its log's epoch, and the prefix and counter it numbers tasks with while the board is away.
CREATE TABLE runner_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
