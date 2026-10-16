-- Autopilot (docs/decisions/0008-autopilot-engine.md). Engine-wide settings live in the settings table.

-- An automation's mode and config at one scope. The board scope has an empty scope_id rather than NULL, so the
-- unique key holds for it too. Epic rows are accepted now; the engine resolves them once epic scope ships.
CREATE TABLE autopilot_settings (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('board', 'project', 'epic')),
  scope_id TEXT NOT NULL,
  automation TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('inherit', 'on', 'off')),
  -- Only the keys set at this scope; the rest inherit.
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_kind, scope_id, automation),
  CHECK ((scope_kind = 'board') = (scope_id = ''))
);

-- scope_id points at a project or an epic depending on scope_kind, so no foreign key can; these stand in for one.
CREATE TRIGGER autopilot_settings_project_deleted AFTER DELETE ON projects BEGIN
  DELETE FROM autopilot_settings WHERE scope_kind = 'project' AND scope_id = OLD.id;
END;
CREATE TRIGGER autopilot_settings_epic_deleted AFTER DELETE ON tasks BEGIN
  DELETE FROM autopilot_settings WHERE scope_kind = 'epic' AND scope_id = OLD.id;
END;

-- What the engine did, or would have done in dry-run. History only: not backed up.
CREATE TABLE autopilot_runs (
  id TEXT PRIMARY KEY,
  automation TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped')),
  -- What the action would do (dry-run) or did.
  summary TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0, 1)),
  -- Filled in by the runner that carried out an agent action.
  runner TEXT,
  session_id TEXT,
  thread_url TEXT,
  worktree_path TEXT,
  cost_usd REAL,
  error TEXT,
  -- Shown as an attention reason on the task until a later run succeeds or the task changes status.
  needs_attention INTEGER NOT NULL DEFAULT 0 CHECK (needs_attention IN (0, 1)),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (automation, dedupe_key, dry_run)
);
CREATE INDEX autopilot_runs_task ON autopilot_runs (task_id, created_at) WHERE task_id IS NOT NULL;
CREATE INDEX autopilot_runs_project ON autopilot_runs (project_id, created_at) WHERE project_id IS NOT NULL;
CREATE INDEX autopilot_runs_status ON autopilot_runs (status);
CREATE INDEX autopilot_runs_created ON autopilot_runs (created_at);
