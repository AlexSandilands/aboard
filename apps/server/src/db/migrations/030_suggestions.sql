-- Suggested changes (docs/features/suggestions.md): an agent's proposed rewrite of a prompt or skill the user can edit,
-- waiting for the user to accept or reject it. Backed up, so a restore keeps what the user hasn't decided yet.
CREATE TABLE suggestions (
  id TEXT PRIMARY KEY,
  -- editableTargetKey in packages/contracts/src/suggestions.ts: "skill:<path>", "builtin:review", "automation:<id>".
  target_key TEXT NOT NULL,
  title TEXT NOT NULL,
  -- The text the agent read and its hash: accepting writes only while the target still has this hash.
  base_text TEXT NOT NULL,
  base_hash TEXT NOT NULL,
  proposed TEXT NOT NULL,
  rationale TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'rejected', 'stale', 'superseded')),
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  outcome TEXT
);
-- One open suggestion per target: a new one supersedes the old.
CREATE UNIQUE INDEX suggestions_open_target ON suggestions (target_key) WHERE status = 'open';
CREATE INDEX suggestions_created ON suggestions (created_at);
