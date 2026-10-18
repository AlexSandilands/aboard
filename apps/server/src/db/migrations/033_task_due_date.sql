-- An optional due date, a plain calendar date (YYYY-MM-DD) with no time or timezone. NULL is none.
ALTER TABLE tasks ADD COLUMN due_date TEXT CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
