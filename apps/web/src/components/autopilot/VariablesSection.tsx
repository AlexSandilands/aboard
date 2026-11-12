import { useRowScope } from "~/components/settings/SettingsScope";
import { SettingsNote, SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { useUpdateProject, useUpdateSettings } from "~/state/mutations";
import { useSettings } from "~/state/queries";
import { VariablesEditor, variablesKey } from "./VariablesEditor";

const NO_SECRETS =
  "Plain text, not for secrets: values show in dry runs, previews, run details and backups. Keep tokens in your shell's own environment or a credential store.";

/**
 * Settings → Autopilot → Limits & safety: the variables every project's automations read. In project scope, that
 * project's overrides, with the board's shown as inherited.
 */
export function VariablesSection() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const updateProject = useUpdateProject();
  const { project } = useRowScope();
  const variables = settings.data?.automationVariables ?? [];
  return (
    <SettingsSection id="autopilot.limits.variables" title="Variables">
      {!settings.data ? (
        <SettingsNote>{settings.error ? settings.error.message : "Loading variables..."}</SettingsNote>
      ) : project ? (
        <SettingsRow
          id="autopilot.limits.variables.list"
          scope="project"
          title={`Variables for ${project.title}`}
          description="Override the board's variables here, or add ones only this project's automations read."
          info={`An empty value overrides the board's with nothing, so automations that need it skip this project. ${NO_SECRETS}`}
        >
          <div className="mt-2">
            <VariablesEditor
              key={`${project.id}:${variablesKey(project.variables)}`}
              idPrefix={project.title}
              variables={project.variables}
              inherited={variables}
              saving={updateProject.isPending}
              onSave={(next) => updateProject.mutate({ id: project.id, variables: next })}
            />
          </div>
        </SettingsRow>
      ) : (
        <SettingsRow
          id="autopilot.limits.variables.list"
          scope="project"
          title="Automation variables"
          description="Values custom automations read, the same in every project unless a project overrides them."
          info={`A prompt reads one as {{vars.name}}; a command or script as an environment variable, or from vars in the JSON on stdin. An automation that needs one doesn't run in a project where it has no value. Choose a project above to override them there. ${NO_SECRETS}`}
        >
          <div className="mt-2">
            <VariablesEditor
              key={variablesKey(variables)}
              idPrefix="Board"
              variables={variables}
              saving={update.isPending}
              onSave={(automationVariables) => update.mutate({ automationVariables })}
            />
          </div>
        </SettingsRow>
      )}
    </SettingsSection>
  );
}
