import { overrideValue, type Project } from "@repo/contracts";
import { inheritDetail, resolvesTo } from "~/components/models/choicePicker.logic";
import { ModelChoicePicker } from "~/components/models/ModelChoicePicker";
import { useUpdateProject } from "~/state/mutations";
import { useSettings } from "~/state/queries";
import { SettingsLink, SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * The project's own models: its reviewer, for the reviewer subagent and the board reviewer, instead of the board's
 * (Settings → Models › Operations). A task can pick its own in its panel.
 */
export function ProjectModelsSection({ project }: { project: Project }) {
  const updateProject = useUpdateProject();
  const settings = useSettings().data;
  if (!settings) return null;
  const ctx = { projectOverride: project.reviewModel };
  return (
    <SettingsSection id="project.models.settings" title="Models">
      <SettingsRow
        id="project.models.reviewer"
        title="Reviewer model"
        description="The model that reviews this project's tasks. A task can pick its own."
        info={
          <>
            Inherit uses the board's, set under{" "}
            <SettingsLink to="agents.operations.reviewer">Models › Operations</SettingsLink>. The board reviewer needs a
            provider that can return structured output.
          </>
        }
        status={
          <>
            <span className="block">
              Reviewer subagent: {resolvesTo("reviewer", ctx, settings).text.replace(/^Resolves to /, "")}
            </span>
            <span className="block">
              Board reviewer: {resolvesTo("boardReviewer", ctx, settings).text.replace(/^Resolves to /, "")}
            </span>
          </>
        }
        control={
          <ModelChoicePicker
            op="reviewer"
            value={project.reviewModel}
            inherit={{ label: "Board's setting", detail: inheritDetail("reviewer", {}, settings) }}
            ariaLabel="Reviewer model for this project"
            size="sm"
            onChange={(next) => updateProject.mutate({ id: project.id, reviewModel: overrideValue(next) })}
          />
        }
      />
    </SettingsSection>
  );
}
