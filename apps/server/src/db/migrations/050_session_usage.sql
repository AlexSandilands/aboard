-- Tokens agents spent, read from the sessions and threads linked to tasks and from the board's own runs
-- (docs/features/token-usage.md). Cost is worked out when read, from the price table, so it isn't stored, except a
-- cost a headless run reported itself. Kept even after the source files are gone (Claude Code deletes transcripts
-- after 30 days), so backups include it with its cursors: restoring one without the other would read it all again.
CREATE TABLE session_usage (
  -- claude-code | codex | copilot-cli | t3 (a T3 thread counted from its own turns)
  harness TEXT NOT NULL,
  -- The session or thread id; a board run with no session of its own uses its run id.
  session_id TEXT NOT NULL,
  -- Which of the session's files the tokens came from, relative to the session (`<id>.jsonl`,
  -- `subagents/agent-1.jsonl`, a Codex rollout's file name), so a file that shrank or was replaced has just its own
  -- rows replaced. '' for usage that isn't read from a file (T3 turns, a run's output).
  source_file TEXT NOT NULL,
  -- Local calendar day the tokens were used, YYYY-MM-DD.
  day TEXT NOT NULL,
  -- '' when the source didn't say.
  model TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('transcript', 't3_turn', 'run_output')),
  -- Only for run_output rows: the task the run was for (none for task-less runs) and why it ran.
  task_id TEXT REFERENCES tasks (id) ON DELETE CASCADE,
  purpose TEXT,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write_5m INTEGER NOT NULL DEFAULT 0,
  cache_write_1h INTEGER NOT NULL DEFAULT 0,
  -- A provider's own billing unit (Copilot premium requests), as reported.
  requests REAL,
  -- What the harness said the run cost; only run_output rows have one.
  reported_cost_usd REAL,
  updated_at TEXT,
  PRIMARY KEY (harness, session_id, source_file, day, model)
);
CREATE INDEX idx_session_usage_day ON session_usage (day);
CREATE INDEX idx_session_usage_task ON session_usage (task_id) WHERE task_id IS NOT NULL;

-- How far each source file has been read, so a reread adds only what was appended. `size` tells a file that shrank or
-- was replaced; `state_json` is the reader's own state across reads (the last message counted, the running Codex
-- totals), so a message split across two reads isn't counted twice.
CREATE TABLE session_usage_cursor (
  harness TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_file TEXT NOT NULL,
  offset INTEGER NOT NULL,
  size INTEGER NOT NULL,
  state_json TEXT,
  updated_at TEXT,
  PRIMARY KEY (harness, session_id, source_file)
);

-- The provider sessions behind a T3 Code thread (its providerThreads' native refs), so a task that links the thread
-- finds the usage stored under each session. A thread can have several after a hand-off or fork. A thread counted from
-- its own turns maps to itself under harness 't3'.
CREATE TABLE session_usage_thread (
  thread_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (thread_id, harness, session_id)
);
