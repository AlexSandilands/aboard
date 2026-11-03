import type { AppSettings, IntegrationsStatus } from "@repo/contracts";
import { Badge } from "~/components/ui/badge";
import { Switch } from "~/components/ui/switch";
import { useUpdateSettings } from "~/state/mutations";
import { githubDot, type IntegrationDot } from "./integrations.logic";
import { SettingsRow, SettingsSection, StatusDot } from "./settingsLayout";

const Dot = ({ dot }: { dot: IntegrationDot }) => <StatusDot tone={dot.tone} label={dot.label} />;

export function GithubSection({
  settings,
  status,
}: {
  settings: AppSettings;
  status: IntegrationsStatus["github"] | undefined;
}) {
  const updateSettings = useUpdateSettings();
  const description =
    status === undefined
      ? "Checking the GitHub CLI..."
      : !status.available
        ? "gh isn't installed. PR links still work, without live status."
        : !status.authenticated
          ? (status.error ?? "gh isn't signed in. Run `gh auth login`.")
          : "PR status and merging use the account gh is signed in with.";
  return (
    <SettingsSection id="integrations.github.status" title="GitHub" status={<Dot dot={githubDot(status)} />}>
      <SettingsRow
        id="integrations.github.cli"
        title="GitHub CLI"
        description={description}
        info="Add a GitHub Enterprise host with `gh auth login --hostname <host>`."
        control={
          status === undefined ? null : status.available && status.authenticated ? (
            <Badge variant="success">Ready</Badge>
          ) : (
            <Badge variant="warning">{status.available ? "Not signed in" : "Not found"}</Badge>
          )
        }
      />
      {status?.hosts.map((host) => (
        <SettingsRow
          key={host.host}
          id={`integrations.github.host-${host.host}`}
          title={host.host}
          description={
            host.authenticated
              ? `Signed in${host.login ? ` as ${host.login}` : ""}.`
              : `Sign-in expired. Run \`gh auth login --hostname ${host.host}\`.`
          }
          control={
            host.authenticated ? (
              <Badge variant="success">Signed in</Badge>
            ) : (
              <Badge variant="warning">Not signed in</Badge>
            )
          }
        />
      ))}
      <SettingsRow
        id="integrations.github.poll-prs"
        title="Poll PR status"
        description="Refresh the state, checks and reviews of PR links every 2 minutes."
        info="Covers github.com and the Enterprise hosts gh is signed in to."
        control={
          <Switch
            aria-label="Poll PR status"
            checked={settings.githubPolling}
            onCheckedChange={(checked) => updateSettings.mutate({ githubPolling: checked })}
          />
        }
      />
    </SettingsSection>
  );
}
