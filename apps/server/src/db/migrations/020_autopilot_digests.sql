-- Digests of what changed (docs/features/autopilot.md): the Autopilot digest automation's output, kept so the board
-- can show the latest and the last few. History only: not backed up; the newest 30 are kept.
CREATE TABLE autopilot_digests (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  -- The period it covers, as instants: from the previous digest's end (the last 24 hours for the first) to now.
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  -- What the body is: plain (built by the board) or summarised (written by an agent).
  mode TEXT NOT NULL CHECK (mode IN ('plain', 'summarised')),
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  body_md TEXT NOT NULL,
  cost_usd REAL,
  -- Why a summarised digest is plain, when it fell back.
  note TEXT,
  -- Null until the user has opened it: the header's unread dot.
  read_at TEXT
);
CREATE INDEX autopilot_digests_created ON autopilot_digests (created_at);
