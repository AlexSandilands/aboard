-- Free-form labels on tasks (e.g. "ui", "backend"), shared across the board.
CREATE TABLE task_labels (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  PRIMARY KEY (task_id, label)
);
CREATE INDEX task_labels_label ON task_labels (label);

-- Colour overrides only: a label without a row takes a hue hashed from its name. Rows stay when the
-- label falls out of use, so a reused label keeps its colour.
CREATE TABLE label_colors (
  label TEXT PRIMARY KEY,
  hue INTEGER NOT NULL CHECK (hue >= 0 AND hue < 360)
);
