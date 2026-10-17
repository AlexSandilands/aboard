import { BUILTIN_PLAN_SKILL_NAME, planSkillName, type AppSettings, type Project } from "@repo/contracts";
import { skillOptions } from "~/components/review/review.logic";
import { useUpdateProject, useUpdateSettings } from "~/state/mutations";
import { useSettings, useSkills } from "~/state/queries";
import { ReviewSkillSelect } from "./ReviewSettingsSection";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** The skill bulk planning sessions ("Plan tasks…" in a lane header) follow, board-wide. */
export function PlanSkillSection({ settings }: { settings: AppSettings }) {
  const updateSettings = useUpdateSettings();
  // The global skill can't come from one project's folder; projects override it in their own settings.
  const skills = useSkills(null).data ?? [];
  const options = skillOptions(
    skills.filter((s) => s.source === "global"),
    settings.planSkill,
    { builtinLabel: BUILTIN_PLAN_SKILL_NAME },
  );
  return (
    <SettingsSection id="tasks.planning.settings" title="Planning">
      <SettingsRow
        id="tasks.planning.skill"
        title="Planning skill"
        description="What a session started with Plan tasks… follows to plan the tasks you picked with you. Skills installed for Claude Code, Copilot or Codex are listed; a project can pick one of its own on its settings page."
        control={
          <ReviewSkillSelect
            ariaLabel="Planning skill"
            options={options}
            value={settings.planSkill}
            onChange={(skill) => {
              if (skill) updateSettings.mutate({ planSkill: skill });
            }}
          />
        }
      />
    </SettingsSection>
  );
}

/** The project's planning skill: the board's, or a skill of its own (from its folder or the user's). */
export function ProjectPlanSkillSection({ project }: { project: Project }) {
  const updateProject = useUpdateProject();
  const settings = useSettings().data;
  const skills = useSkills(project.id).data ?? [];
  const inherited = settings ? planSkillName(settings.planSkill) : "the board's";
  return (
    <SettingsSection id="project.plan-skill.settings" title="Planning">
      <SettingsRow
        id="project.plan-skill.skill"
        title="Planning skill"
        description={
          project.workspaceRoot
            ? "Skills in the project's .claude/skills, .github/skills or .agents/skills folders are listed first."
            : "Set a workspace folder to pick a skill from the project's own folders."
        }
        control={
          <ReviewSkillSelect
            ariaLabel="Planning skill for this project"
            options={skillOptions(skills, project.planSkill, {
              inheritLabel: `Default (${inherited})`,
              builtinLabel: BUILTIN_PLAN_SKILL_NAME,
            })}
            value={project.planSkill}
            onChange={(planSkill) => updateProject.mutate({ id: project.id, planSkill })}
          />
        }
      />
    </SettingsSection>
  );
}
