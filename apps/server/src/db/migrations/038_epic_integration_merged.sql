-- When the user marked an integration epic merged into the default branch by hand (no PR to watch). Only an epic has
-- it; the epic is Done once its tasks are and its branch has merged, and this stands in for the merge. Cleared when
-- the delivery changes.
ALTER TABLE tasks ADD COLUMN integration_merged_at TEXT;
