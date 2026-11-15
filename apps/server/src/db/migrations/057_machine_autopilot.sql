-- Autopilot on a connected machine (docs/features/remote-machines.md#autopilot-on-the-machine).

-- On a board: the machine whose own Autopilot made a run, replayed from that machine's log. NULL for a run made
-- here. The name is kept beside the id so the run still says where it ran once the machine is removed.
ALTER TABLE autopilot_runs ADD COLUMN machine_id TEXT;
ALTER TABLE autopilot_runs ADD COLUMN machine_name TEXT;

-- On a board: a machine's own Autopilot limits (AutopilotLimits); NULL while it goes by the board's.
ALTER TABLE machines ADD COLUMN autopilot_limits_json TEXT;

-- The machine a task-less scheduled automation runs on: on a board, its id in `machines`; on a runner, the instance id
-- of the runner it is pinned to. NULL runs it on the board.
ALTER TABLE autopilot_custom ADD COLUMN machine_id TEXT;
