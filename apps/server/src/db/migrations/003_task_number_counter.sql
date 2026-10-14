-- Task numbers come from a high-water mark that never goes down, so deleting the newest task
-- doesn't hand its #number to the next one (notes, PRs and events refer to tasks by number).
CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO counters (name, value) SELECT 'task_number', COALESCE(MAX(number), 0) FROM tasks;
