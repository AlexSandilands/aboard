import type { AppSettings } from "@repo/contracts";
import { Switch } from "~/components/ui/switch";
import { useUpdateSettings } from "~/state/mutations";
import { BlurInput } from "./BlurInput";
import { parseToolList } from "./issueImport.logic";
import { SettingsLink, SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * Importing a task from a Jira or GitHub issue URL: Claude Code headless fills in its title, description and
 * labels. It runs the Claude Code CLI set under Integrations, as the board reviewer does.
 */
export function IssueImportSection({ settings }: { settings: AppSettings }) {
  const updateSettings = useUpdateSettings();
  return (
    <SettingsSection id="tasks.new-tasks.issue-import" title="Issue import">
      <SettingsRow
        id="tasks.new-tasks.import-enabled"
        title="Fill in imported tasks"
        description={
          <>
            Paste a Jira key or URL, or a GitHub issue URL, as a new task&apos;s title and Claude Code fills in its
            title, description and labels. It uses the CLI set under{" "}
            <SettingsLink to="integrations.claude-code.cli-path">Integrations › Claude Code</SettingsLink>. Without
            this, a GitHub issue is imported as written and a Jira issue can&apos;t be imported.
          </>
        }
        control={
          <Switch
            aria-label="Fill in imported tasks"
            checked={settings.issueImportEnabled}
            onCheckedChange={(checked) => updateSettings.mutate({ issueImportEnabled: checked })}
          />
        }
      />
      {settings.issueImportEnabled ? (
        <>
          <SettingsRow
            id="tasks.new-tasks.import-model"
            title="Model"
            description="Passed to claude --model: an alias such as haiku, or a full model name."
            control={
              <BlurInput
                aria-label="Import model"
                size="sm"
                className="sm:w-40"
                placeholder="haiku"
                value={settings.issueImportModel}
                onSave={(next) => {
                  if (next.trim()) updateSettings.mutate({ issueImportModel: next.trim() });
                }}
              />
            }
          />
          <SettingsRow
            id="tasks.new-tasks.import-budget"
            title="Budget per import"
            description="The most one import may spend, in US dollars (claude --max-budget-usd)."
            control={
              <BlurInput
                aria-label="Budget per import in US dollars"
                size="sm"
                className="sm:w-24"
                inputMode="decimal"
                value={String(settings.issueImportBudgetUsd)}
                onSave={(next) => {
                  const amount = Number(next);
                  if (Number.isFinite(amount) && amount > 0 && amount <= 100) {
                    updateSettings.mutate({ issueImportBudgetUsd: amount });
                  }
                }}
              />
            }
          />
          <SettingsRow
            id="tasks.new-tasks.import-jira-tools"
            title="Jira tools"
            description="Jira issues are read through your own Jira MCP server in Claude Code (one added for you, not for a single project), with these tools allowed, comma-separated (for example mcp__atlassian__getJiraIssue), and tools that look like writes denied. Leave empty to look for the common read-only Jira tools on every MCP server you have."
            control={
              <BlurInput
                aria-label="Jira tools"
                size="sm"
                className="sm:w-72"
                placeholder="mcp__<server>__<tool>, …"
                value={settings.issueImportJiraTools.join(", ")}
                onSave={(next) => updateSettings.mutate({ issueImportJiraTools: parseToolList(next) })}
              />
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
