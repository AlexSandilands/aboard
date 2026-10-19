import type { Project } from "@repo/contracts";
import { SettingsNote, SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { useUpdateProject, useUpdateSettings } from "~/state/mutations";
import { useSettings } from "~/state/queries";
import { VariablesEditor, variablesKey } from "./VariablesEditor";

const NO_SECRETS =
  "Plain text, not for secrets: values show in dry runs, previews, run details and backups. Keep tokens in your shell's own environment or a credential store.";

/** Settings → Autopilot → Custom automations: the variables every project's automations read, unless it overrides them. */
export function BoardVariablesSection() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const variables = settings.data?.automationVariables ?? [];
  return (
    <SettingsSection id="autopilot.custom.variables" title="Variables">
      {settings.data ? (
        <SettingsRow
          id="autopilot.custom.variables.list"
          title="Automation variables"
          description="Values custom automations read, the same in every project unless a project overrides them."
          info={`A prompt reads one as {{vars.name}}; a command or script as an environment variable, or from vars in the JSON on stdin. An automation that needs one doesn't run in a project where it has no value. ${NO_SECRETS}`}
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
      ) : (
        <SettingsNote>{settings.error ? settings.error.message : "Loading variables..."}</SettingsNote>
      )}
    </SettingsSection>
  );
}

/** A project's overrides of the board's automation variables, in its settings. */
export function ProjectVariablesSection({ project }: { project: Project }) {
  const board = useSettings().data?.automationVariables ?? [];
  const update = useUpdateProject();
  return (
    <SettingsSection id="project.autopilot.variables" title="Automation variables">
      <SettingsRow
        id="project.autopilot.variables.list"
        title="Variables for this project"
        description="Override the board's variables here, or add ones only this project's automations read."
        info={`An empty value overrides the board's with nothing, so automations that need it skip this project. ${NO_SECRETS}`}
      >
        <div className="mt-2">
          <VariablesEditor
            key={variablesKey(project.variables)}
            idPrefix={project.title}
            variables={project.variables}
            inherited={board}
            saving={update.isPending}
            onSave={(variables) => update.mutate({ id: project.id, variables })}
          />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
