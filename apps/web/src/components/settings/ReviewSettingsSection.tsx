import { reviewSkillName, type AppSettings, type Project, type ReviewSkillRef } from "@repo/contracts";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { skillKey, skillOptions, type SkillOption } from "~/components/review/review.logic";
import { useUpdateProject, useUpdateSettings } from "~/state/mutations";
import { useOverridingProjects, useSkills } from "~/state/queries";
import { HeadlessReviewerRows } from "./HeadlessReviewerRows";
import { OperationModelLink } from "./OperationModelLink";
import { OverriddenInProjects } from "./SettingsScope";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const ROUND_LIMITS = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} round${n === 1 ? "" : "s"}` }));

/** A select over review skills: the built-in one plus SKILL.md files found on disk. */
export function ReviewSkillSelect({
  options,
  value,
  onChange,
  ariaLabel,
  className = "sm:w-56",
}: {
  options: SkillOption[];
  value: ReviewSkillRef | null;
  onChange: (skill: ReviewSkillRef | null) => void;
  ariaLabel: string;
  /** The trigger's width classes; the default suits a row on its own page. */
  className?: string;
}) {
  return (
    <Select
      items={options.map((o) => ({ value: o.value, label: o.label }))}
      value={skillKey(value)}
      onValueChange={(key) => {
        const option = options.find((o) => o.value === key);
        if (option) onChange(option.skill);
      }}
    >
      <SelectTrigger size="sm" className={className} aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            <span className="truncate">{o.label}</span>
            {o.detail ? <span className="ms-2 shrink-0 text-xs text-muted-foreground">{o.detail}</span> : null}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** Local review settings, board-wide. A project can pick its own review skill under Projects. */
export function ReviewSettingsSection({ settings }: { settings: AppSettings }) {
  const updateSettings = useUpdateSettings();
  // The board's skill can't come from one project's folder, so only the user's are listed.
  const skills = useSkills(null).data ?? [];
  const overriding = useOverridingProjects("reviewSkill");
  const skillControl = (
    <ReviewSkillSelect
      ariaLabel="Review skill"
      options={skillOptions(
        skills.filter((s) => s.source === "global"),
        settings.reviewSkill,
      )}
      value={settings.reviewSkill}
      onChange={(skill) => {
        if (skill) updateSettings.mutate({ reviewSkill: skill });
      }}
    />
  );
  return (
    <SettingsSection id="tasks.review.settings" title="Local review">
      <SettingsRow
        id="tasks.review.before-pr"
        title="Review before the PR"
        description="An agent reviews and fixes its work before opening the pull request."
        info="When an agent moves a task to Review, it runs a review loop with a fresh reviewer subagent and fixes what it finds first. Tasks can turn this off or on for themselves."
        control={
          <Switch
            aria-label="Review before the PR"
            checked={settings.autoReview}
            onCheckedChange={(checked) => updateSettings.mutate({ autoReview: checked })}
          />
        }
      />
      <SettingsRow
        id="tasks.review.skill"
        title="Review skill"
        description="What the reviewer follows."
        info="Skills installed for Claude Code, Copilot or Codex are listed. A project can pick one of its own under Projects."
        status={
          overriding.length > 0 ? (
            <OverriddenInProjects projects={overriding} target="project.overrides.review-skill" />
          ) : null
        }
        control={skillControl}
      />
      <SettingsRow
        id="tasks.review.rounds"
        title="Rounds"
        description="The agent stops after this many rounds and flags open blocking or major findings."
        control={
          <Select
            items={ROUND_LIMITS}
            value={String(settings.reviewMaxRounds)}
            onValueChange={(value) => {
              if (value) updateSettings.mutate({ reviewMaxRounds: Number(value) });
            }}
          >
            <SelectTrigger size="sm" className="sm:w-32" aria-label="Rounds">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {ROUND_LIMITS.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <OperationModelLink ops={["reviewer", "boardReviewer"]} settings={settings} />
      <HeadlessReviewerRows settings={settings} />
    </SettingsSection>
  );
}

/** Projects › overrides: the project's review skill, one of its folder's or the user's, which beats the board's. */
export function ProjectReviewSkillRow({ project, settings }: { project: Project; settings: AppSettings }) {
  const updateProject = useUpdateProject();
  const skills = useSkills(project.id).data ?? [];
  return (
    <SettingsRow
      id="project.overrides.review-skill"
      title="Review skill"
      description={
        project.workspaceRoot
          ? "What the reviewer of this project's tasks follows."
          : "Set the project's workspace folder to pick one of its own skills."
      }
      info="The project's own skills (in its .claude/skills, .github/skills or .agents/skills folders) are listed first."
      override={
        project.reviewSkill
          ? { label: "review skill", onReset: () => updateProject.mutate({ id: project.id, reviewSkill: null }) }
          : null
      }
      control={
        <ReviewSkillSelect
          ariaLabel={`Review skill for ${project.title}`}
          options={skillOptions(skills, project.reviewSkill, {
            inheritLabel: `Board's (${reviewSkillName(settings.reviewSkill)})`,
          })}
          value={project.reviewSkill}
          onChange={(reviewSkill) => updateProject.mutate({ id: project.id, reviewSkill })}
        />
      }
    />
  );
}
