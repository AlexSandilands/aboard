-- Run health (docs/features/autopilot.md#auto-pause). `deferred` says why a skipped run stopped short and its work comes
-- again later (AutopilotRunDeferral: the PR's head moved); NULL for every other run.
ALTER TABLE autopilot_runs ADD COLUMN deferred TEXT;

-- An automation paused in one project after failing there several times in a row, until the user resumes it.
-- `counted_from` is when the failures start counting again: set on Resume, so the failures before it don't pause it at
-- once. A row with paused_at NULL is a resumed automation that keeps only that mark.
CREATE TABLE autopilot_auto_pauses (
  automation TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  paused_at TEXT,
  reason TEXT,
  counted_from TEXT,
  PRIMARY KEY (automation, project_id)
);
