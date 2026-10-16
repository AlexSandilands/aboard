-- "blocker blocks blocked": the blocked task isn't ready until the blocker is Done. Stored once; "blocked by" is
-- the same row read from the other side. Relations cross projects. The service keeps them acyclic.
CREATE TABLE task_relations (
  blocker_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX task_relations_blocked ON task_relations (blocked_id);
