-- Tokens a session or a run used on a connected machine, as that machine read them and sent them with the task's
-- changes (docs/features/token-usage.md#on-a-connected-machine). `machine_id` is the board's machine it came from;
-- null for what this board read itself. The files behind such a row aren't on this machine, so nothing here rereads it.
ALTER TABLE session_usage ADD COLUMN machine_id TEXT;
