-- Manual tasks are for people to track: agents and Autopilot leave them alone, and they need no plan. 1 is manual.
ALTER TABLE tasks ADD COLUMN manual INTEGER NOT NULL DEFAULT 0 CHECK (manual IN (0, 1));
