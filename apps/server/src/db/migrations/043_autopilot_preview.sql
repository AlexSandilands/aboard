-- Preview, a per-automation dry run (docs/features/autopilot.md#switches-and-scopes): autopilot_settings' mode gains
-- 'preview', and `last_on_mode` remembers the last on-mode ('on' or 'preview') a scope chose, so the list's switch can
-- restore it after Off. SQLite can't change a CHECK in place, so the table is rebuilt as in 036; the triggers that
-- delete its rows are dropped first and made again, since they name it.
DROP TRIGGER autopilot_settings_project_deleted;
DROP TRIGGER autopilot_settings_epic_deleted;
DROP TRIGGER autopilot_custom_deleted;

CREATE TABLE autopilot_settings_new (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('board', 'project', 'epic')),
  scope_id TEXT NOT NULL,
  automation TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('inherit', 'on', 'preview', 'off')),
  -- Only the keys set at this scope; the rest inherit.
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  last_on_mode TEXT CHECK (last_on_mode IN ('on', 'preview')),
  PRIMARY KEY (scope_kind, scope_id, automation),
  CHECK ((scope_kind = 'board') = (scope_id = ''))
);

INSERT INTO autopilot_settings_new (scope_kind, scope_id, automation, mode, config_json, updated_at, last_on_mode)
SELECT scope_kind, scope_id, automation, mode, config_json, updated_at, CASE mode WHEN 'on' THEN 'on' END
FROM autopilot_settings;

DROP TABLE autopilot_settings;
ALTER TABLE autopilot_settings_new RENAME TO autopilot_settings;

CREATE TRIGGER autopilot_settings_project_deleted AFTER DELETE ON projects BEGIN
  DELETE FROM autopilot_settings WHERE scope_kind = 'project' AND scope_id = OLD.id;
END;
CREATE TRIGGER autopilot_settings_epic_deleted AFTER DELETE ON tasks BEGIN
  DELETE FROM autopilot_settings WHERE scope_kind = 'epic' AND scope_id = OLD.id;
END;
CREATE TRIGGER autopilot_custom_deleted AFTER DELETE ON autopilot_custom BEGIN
  DELETE FROM autopilot_settings WHERE automation = 'custom:' || OLD.id;
END;
