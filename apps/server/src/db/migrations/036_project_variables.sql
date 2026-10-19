-- A project's overrides of the board's automation variables, as a JSON array of {name, value}. The board's own are a
-- settings row (automationVariables).
ALTER TABLE projects ADD COLUMN variables_json TEXT NOT NULL DEFAULT '[]';
