-- Automations an agent drafted over MCP (draft_automation) for the user to review and import
-- (docs/features/autopilot.md#drafts). bundle_json is the shared-file shape the import page reads. Not backed up: a
-- draft is a hand-off that expires, and only the import makes it the user's data.
CREATE TABLE autopilot_drafts (
  id TEXT PRIMARY KEY,
  bundle_json TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX autopilot_drafts_expires ON autopilot_drafts (expires_at);
