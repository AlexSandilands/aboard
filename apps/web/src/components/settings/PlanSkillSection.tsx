import { BUILTIN_PLAN_SKILL_NAME, planSkillName, type AppSettings } from "@repo/contracts";
import { skillOptions } from "~/components/review/review.logic";
import { useUpdateProject, useUpdateSettings } from "~/state/mutations";
import { useSkills } from "~/state/queries";
import { ReviewSkillSelect } from "./ReviewSettingsSection";
import { useRowScope } from "./SettingsScope";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * The skill bulk planning sessions ("Plan tasks…" in a lane header) follow: the board's, or in project scope the
 * project's own (one of its folder's skills, or the user's), which beats the board's.
 */
export function PlanSkillSection({ settings }: { settings: AppSettings }) {
  const updateSettings = useUpdateSettings();
  const updateProject = useUpdateProject();
  const { project } = useRowScope();
  // The board's skill can't come from one project's folder, so All projects lists only the user's.
  const skills = useSkills(project?.id ?? null).data ?? [];
  const control = project ? (
    <ReviewSkillSelect
      ariaLabel={`Planning skill for ${project.title}`}
      options={skillOptions(skills, project.planSkill, {
        inheritLabel: `Board's (${planSkillName(settings.planSkill)})`,
        builtinLabel: BUILTIN_PLAN_SKILL_NAME,
      })}
      value={project.planSkill}
      onChange={(planSkill) => updateProject.mutate({ id: project.id, planSkill })}
    />
  ) : (
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
  );
  return (
    <SettingsSection id="tasks.planning.settings" title="Planning">
      <SettingsRow
        id="tasks.planning.skill"
        scope="project"
        title="Planning skill"
        description={
          project && !project.workspaceRoot
            ? "Set the project's workspace folder to pick one of its own skills."
            : "What a Plan tasks… session follows to plan the tasks you picked."
        }
        info={
          project
            ? "The project's own skills (in its .claude/skills, .github/skills or .agents/skills folders) are listed first."
            : "Skills installed for Claude Code, Copilot or Codex are listed. Choose a project above to give it one of its own."
        }
        override={
          project?.planSkill
            ? {
                label: "planning skill",
                onReset: () => updateProject.mutate({ id: project.id, planSkill: null }),
              }
            : null
        }
        control={control}
      />
    </SettingsSection>
  );
}
