-- The run history page filters one automation's runs by time and pages them newest first.
CREATE INDEX autopilot_runs_automation ON autopilot_runs (automation, created_at DESC, id DESC);
