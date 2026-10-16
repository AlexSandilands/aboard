-- Recurring tasks (docs/features/autopilot.md): a rule makes a task from a template on a schedule. A rule belongs to
-- one project and goes with it. Rules are configuration, so they are backed up (the runs they cause are not).
CREATE TABLE autopilot_recurring (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- NULL once the template is deleted; the rule then fails each slot until it is given another.
  template_id TEXT REFERENCES task_templates(id) ON DELETE SET NULL,
  -- { "kind": "weekly", "days": [1], "time": "09:00" } or { "kind": "every", "everyDays": 14, "startDate": "...", "time": "..." }
  schedule_json TEXT NOT NULL,
  -- Whether the tasks it creates carry the Autopilot flag (On).
  flag_autopilot INTEGER NOT NULL DEFAULT 0 CHECK (flag_autopilot IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  -- Slots up to here are dealt with. Set to the creation time, and again when the rule is switched on or its schedule
  -- changes, so a new rule doesn't fire for a slot that passed before it existed.
  last_due_at TEXT NOT NULL,
  last_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX autopilot_recurring_project ON autopilot_recurring (project_id);
