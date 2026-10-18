-- Per-task auto-merge flag, the same pattern as autopilot: null is Default, 1 On, 0 Off. merge_task_pr only merges a
-- task's PR into the default branch when it is On; Default is Off.
ALTER TABLE tasks ADD COLUMN auto_merge INTEGER CHECK (auto_merge IN (0, 1));
