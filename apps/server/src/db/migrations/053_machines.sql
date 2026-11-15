-- The machines a board is connected to (docs/features/remote-machines.md#connecting-a-machine). Not part of a
-- backup: which machines a board reaches, and how, belongs to the machine the board runs on. No secret is here; the
-- token for each is in the data dir's machine-tokens.json.
CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  -- The runner's instance id: who must answer on every route.
  instance_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  -- Numbers the tasks made on the machine while the board can't be reached (#E7). Stored in capitals.
  prefix TEXT NOT NULL UNIQUE,
  -- 1 once a task carries the prefix, after which it can't change.
  prefix_fixed INTEGER NOT NULL DEFAULT 0,
  -- MachineRoute[], in the order they are tried.
  routes_json TEXT NOT NULL,
  -- What the machine last said of itself; NULL until it has answered.
  version TEXT,
  protocol_version INTEGER,
  platform TEXT,
  logins_json TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);
