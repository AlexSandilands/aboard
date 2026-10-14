-- Local review: rounds of review on a task and the findings each round raised.
-- NULL inherits the global auto-review setting; 0/1 override it for this task.
ALTER TABLE tasks ADD COLUMN auto_review INTEGER CHECK (auto_review IN (0, 1));
-- NULL inherits the global review skill.
ALTER TABLE projects ADD COLUMN review_skill_json TEXT;

CREATE TABLE task_reviews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  -- Each move to Review starts a new cycle; the round limit applies per cycle.
  cycle INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'stalled', 'submitted', 'failed')),
  trigger TEXT NOT NULL CHECK (trigger IN ('move', 'manual')),
  opened_by TEXT NOT NULL,
  reviewer TEXT,
  skill TEXT,
  head_sha TEXT,
  summary TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (task_id, round)
);

CREATE TABLE review_findings (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES task_reviews(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- 1-based order within the round; with the round it forms the "R2.3" label.
  position INTEGER NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('blocking', 'major', 'minor', 'nit')),
  file TEXT,
  line INTEGER,
  title TEXT NOT NULL,
  body TEXT,
  suggestion TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'fixed', 'wont_fix')),
  resolution_note TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (review_id, position)
);
CREATE INDEX review_findings_task ON review_findings (task_id);
