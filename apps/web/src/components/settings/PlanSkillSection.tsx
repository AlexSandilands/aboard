import { BUILTIN_PLAN_SKILL_NAME, planSkillName, type AppSettings, type Project } from "@repo/contracts";
import { skillOptions } from "~/components/review/review.logic";
import { useUpdateProject, useUpdateSettings } from "~/state/mutations";
import { useOverridingProjects, useSkills } from "~/state/queries";
import { ReviewSkillSelect } from "./ReviewSettingsSection";
import { OverriddenInProjects } from "./SettingsScope";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** The skill bulk planning sessions ("Plan tasks…" in a lane header) follow, board-wide. */
export function PlanSkillSection({ settings }: { settings: AppSettings }) {
  const updateSettings = useUpdateSettings();
  // The board's skill can't come from one project's folder, so only the user's are listed.
  const skills = useSkills(null).data ?? [];
  const overriding = useOverridingProjects("planSkill");
  return (
    <SettingsSection id="tasks.planning.settings" title="Planning">
      <SettingsRow
        id="tasks.planning.skill"
        title="Planning skill"
        description="What a Plan tasks… session follows to plan the tasks you picked."
        info="Skills installed for Claude Code, Copilot or Codex are listed. A project can pick one of its own under Projects."
        status={
          overriding.length > 0 ? (
            <OverriddenInProjects projects={overriding} target="project.overrides.plan-skill" />
          ) : null
        }
        control={
          <ReviewSkillSelect
            ariaLabel="Planning skill"
            options={skillOptions(
              skills.filter((s) => s.source === "global"),
              settings.planSkill,
              { builtinLabel: BUILTIN_PLAN_SKILL_NAME },
            )}
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

/** Projects › overrides: the project's planning skill, one of its folder's or the user's, which beats the board's. */
export function ProjectPlanSkillRow({ project, settings }: { project: Project; settings: AppSettings }) {
  const updateProject = useUpdateProject();
  const skills = useSkills(project.id).data ?? [];
  return (
    <SettingsRow
      id="project.overrides.plan-skill"
      title="Planning skill"
      description={
        project.workspaceRoot
          ? "What a Plan tasks… session in this project follows."
          : "Set the project's workspace folder to pick one of its own skills."
      }
      info="The project's own skills (in its .claude/skills, .github/skills or .agents/skills folders) are listed first."
      override={
        project.planSkill
          ? { label: "planning skill", onReset: () => updateProject.mutate({ id: project.id, planSkill: null }) }
          : null
      }
      control={
        <ReviewSkillSelect
          ariaLabel={`Planning skill for ${project.title}`}
          options={skillOptions(skills, project.planSkill, {
            inheritLabel: `Board's (${planSkillName(settings.planSkill)})`,
            builtinLabel: BUILTIN_PLAN_SKILL_NAME,
          })}
          value={project.planSkill}
          onChange={(planSkill) => updateProject.mutate({ id: project.id, planSkill })}
        />
      }
    />
  );
}
