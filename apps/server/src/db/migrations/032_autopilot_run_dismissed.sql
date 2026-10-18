-- When the user dismissed a run's needs-attention flag (docs/features/autopilot.md#needs-attention). The run stays as
-- it was, failed or skipped; only the flag on its task stops standing. Null for a run never dismissed.
ALTER TABLE autopilot_runs ADD COLUMN dismissed_at TEXT;
