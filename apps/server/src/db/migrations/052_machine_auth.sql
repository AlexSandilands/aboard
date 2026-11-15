-- A runner's pairing state (docs/features/remote-machines.md#pairing). Neither table is part of a backup, and neither
-- holds a secret: codes and tokens are stored as SHA-256 hashes, and the board keeps its token in a file of its own.

-- One-time codes that `<id>-server pair` prints. A code is deleted when it is used or has expired.
CREATE TABLE machine_pairing_codes (
  code_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- The tokens paired boards hold. `id` is the public half of the token (`<id>.<secret>`), which finds the row;
-- `secret_hash` proves the rest. A revoked token's row is deleted.
CREATE TABLE machine_tokens (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  board_instance_id TEXT NOT NULL,
  board_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
