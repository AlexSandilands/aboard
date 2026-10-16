-- Task templates: a starting point for new tasks (title pattern, description, labels, optional plan). A template
-- is board-wide (project_id NULL) or belongs to one project. Creating a task copies the template's fields, so
-- editing or deleting a template never touches tasks made from it; the task only remembers which one it came from.
CREATE TABLE task_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  -- May hold {{date}} and {{project}}; used as the title when none is given.
  title_pattern TEXT NOT NULL DEFAULT '',
  description TEXT,
  labels_json TEXT NOT NULL DEFAULT '[]',
  plan_context TEXT,
  -- [{ "title": "...", "steps": [{ "title": "...", "notes": "..." }] }]; empty means no plan.
  phases_json TEXT NOT NULL DEFAULT '[]',
  suggested_tier TEXT CHECK (suggested_tier IN ('light', 'standard', 'deep')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX task_templates_project ON task_templates (project_id) WHERE project_id IS NOT NULL;

ALTER TABLE tasks ADD COLUMN template_id TEXT REFERENCES task_templates(id) ON DELETE SET NULL;

-- Starters, editable and deletable like any other template.
INSERT INTO task_templates (id, name, title_pattern, description, labels_json, phases_json, created_at, updated_at)
VALUES
  (lower(hex(randomblob(16))), 'Bug', '',
   replace('## What happens\n\n## Expected\n\n## Steps to reproduce\n', '\n', char(10)),
   '["bug"]',
   '[{"title":"Fix the bug","steps":[{"title":"Reproduce"},{"title":"Fix"},{"title":"Regression test"}]}]',
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  (lower(hex(randomblob(16))), 'Spike', '',
   replace('## Why\n\n## Time box\n', '\n', char(10)),
   '["spike"]',
   '[{"title":"Investigate","steps":[{"title":"Questions"},{"title":"Investigate"},{"title":"Write up findings"}]}]',
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  (lower(hex(randomblob(16))), 'Feature', '',
   replace('## Goal\n\n## Out of scope\n', '\n', char(10)),
   '["feature"]',
   '[{"title":"Build","steps":[{"title":"Design"},{"title":"Implement"},{"title":"Tests"},{"title":"Docs"}]}]',
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
