-- A draft can propose a new version of an existing custom automation (draft_automation's `replaces`,
-- docs/features/autopilot.md#drafts): `replaces` holds that automation's id, and applying the draft changes it in place.
-- No foreign key: a draft whose automation was deleted since is told so when applied, not dropped behind its back.
ALTER TABLE autopilot_drafts ADD COLUMN replaces TEXT;
