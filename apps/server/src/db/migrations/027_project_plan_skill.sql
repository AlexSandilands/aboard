-- The planning skill a project's bulk-planning sessions follow, as JSON (a PlanSkillRef); null inherits the board's.
ALTER TABLE projects ADD COLUMN plan_skill_json TEXT;
