-- One reviewer model for the review subagent and the board reviewer: the board reviewer's model setting moves to its
-- new key. An old backup still carries the old key; restoring it runs this migration over the dump.
UPDATE settings SET key = 'reviewModel' WHERE key = 'headlessReviewModel';
-- The same choice per project and per task; NULL inherits (task, then project, then the board's reviewModel setting).
ALTER TABLE projects ADD COLUMN review_model_json TEXT;
ALTER TABLE tasks ADD COLUMN review_model_json TEXT;
