-- The board reads a headless session's state from its run on every session poll.
CREATE INDEX autopilot_runs_session ON autopilot_runs (session_id) WHERE session_id IS NOT NULL;
