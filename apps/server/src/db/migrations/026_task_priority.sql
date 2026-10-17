-- Priority tasks show in a lane above every project, whichever project they belong to. 1 is priority, 0 is not.
ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0 CHECK (priority IN (0, 1));
