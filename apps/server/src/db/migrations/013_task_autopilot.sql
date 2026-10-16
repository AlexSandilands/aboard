-- Per-task Autopilot flag, the same pattern as auto_review: null is Default, 1 On, 0 Off. Start planned tasks only
-- starts a task flagged On; Default never auto-starts.
ALTER TABLE tasks ADD COLUMN autopilot INTEGER CHECK (autopilot IN (0, 1));
