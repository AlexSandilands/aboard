-- A structured result an automation leaves on its run, for later automations to read (the PR review's verdict,
-- which the fix automation picks up). JSON; null for runs that have none.
ALTER TABLE autopilot_runs ADD COLUMN output_json TEXT;
