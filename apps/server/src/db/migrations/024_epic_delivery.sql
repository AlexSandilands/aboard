-- How an epic's tasks are delivered. null: not chosen, which is pull requests to the default branch; 'main': the user
-- chose that; 'integration': the tasks start from integration_branch and open their pull requests against it, and
-- Autopilot merges them there. Only an epic has these.
ALTER TABLE tasks ADD COLUMN delivery TEXT CHECK (delivery IN ('main', 'integration'));
ALTER TABLE tasks ADD COLUMN integration_branch TEXT;
