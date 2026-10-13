CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  workspace_root TEXT,
  workspace_key TEXT UNIQUE,
  icon_json TEXT,
  t3_project_id TEXT,
  position TEXT NOT NULL,
  collapsed INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  plan_context TEXT,
  status TEXT NOT NULL CHECK (status IN ('idea', 'planned', 'in_progress', 'review', 'done')),
  position TEXT NOT NULL,
  archived_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status_changed_at TEXT NOT NULL
);
CREATE INDEX tasks_lane ON tasks (project_id, status, position);

CREATE TABLE plan_phases (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  position TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX plan_phases_task ON plan_phases (task_id, position);

CREATE TABLE plan_steps (
  id TEXT PRIMARY KEY,
  phase_id TEXT NOT NULL REFERENCES plan_phases(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'done', 'blocked', 'skipped')),
  position TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX plan_steps_phase ON plan_steps (phase_id, position);
CREATE INDEX plan_steps_task ON plan_steps (task_id);

CREATE TABLE task_links (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('pr', 'jira', 't3_thread', 'url')),
  url TEXT NOT NULL,
  label TEXT,
  ref_json TEXT,
  snapshot_json TEXT,
  synced_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, kind, url)
);
CREATE INDEX task_links_task ON task_links (task_id);

CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX task_events_task ON task_events (task_id, id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
