import { reviewSkillName, type Project } from "@repo/contracts";
import { skillOptions } from "~/components/review/review.logic";
import { useUpdateProject } from "~/state/mutations";
import { useSettings, useSkills } from "~/state/queries";
import { ReviewSkillSelect } from "./ReviewSettingsSection";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** The project's review skill: the global one, or a skill of its own (from its folder or the user's). */
export function ProjectReviewSection({ project }: { project: Project }) {
  const updateProject = useUpdateProject();
  const settings = useSettings().data;
  const skills = useSkills(project.id).data ?? [];
  const inherited = settings ? reviewSkillName(settings.reviewSkill) : "the board's";
  return (
    <SettingsSection id="project.review-skill.settings" title="Local review">
      <SettingsRow
        id="project.review-skill.skill"
        title="Review skill"
        description={
          project.workspaceRoot
            ? "The project's own skills are listed first."
            : "Set a workspace folder to pick one of the project's own skills."
        }
        info="Skills in the project's .claude/skills, .github/skills or .agents/skills folders."
        control={
          <ReviewSkillSelect
            ariaLabel="Review skill for this project"
            options={skillOptions(skills, project.reviewSkill, { inheritLabel: `Default (${inherited})` })}
            value={project.reviewSkill}
            onChange={(reviewSkill) => updateProject.mutate({ id: project.id, reviewSkill })}
          />
        }
      />
    </SettingsSection>
  );
}
