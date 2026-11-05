-- What an agent run ran on (RunModelRecord in packages/contracts/src/operations.ts): provider, model, effort and where
-- the choice came from. NULL for other runs and for runs from before it was recorded.
ALTER TABLE autopilot_runs ADD COLUMN model_json TEXT;
