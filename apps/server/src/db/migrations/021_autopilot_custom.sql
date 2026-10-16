-- Custom automations (docs/features/autopilot.md#custom-automations): automations the user defines, each a catalogue
-- entry `custom:<id>` switched per scope like the built-in ones. Configuration, so they are backed up.
CREATE TABLE autopilot_custom (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- CustomTrigger, CustomFilters and CustomAction in packages/contracts/src/customAutomations.ts.
  trigger_json TEXT NOT NULL,
  filters_json TEXT NOT NULL DEFAULT '{}',
  action_json TEXT NOT NULL,
  -- Events before this don't fire, so switching an automation on doesn't act on the board's history.
  armed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX autopilot_custom_name ON autopilot_custom (name COLLATE NOCASE);

-- Its switches go with it; the automation column can't carry a foreign key.
CREATE TRIGGER autopilot_custom_deleted AFTER DELETE ON autopilot_custom BEGIN
  DELETE FROM autopilot_settings WHERE automation = 'custom:' || OLD.id;
END;

-- A shell action's output tail and exit code; for a dry run, what would have run.
ALTER TABLE autopilot_runs ADD COLUMN detail TEXT;
ALTER TABLE autopilot_runs ADD COLUMN exit_code INTEGER;
