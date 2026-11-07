import { gitHostDefinition, type AppSettings, type GitHostStatus } from "@repo/contracts";
import { Badge } from "~/components/ui/badge";
import { Switch } from "~/components/ui/switch";
import { useUpdateSettings } from "~/state/mutations";
import { gitHostDot, type IntegrationDot } from "./integrations.logic";
import { SettingsRow, SettingsSection, StatusDot } from "./settingsLayout";

const Dot = ({ dot }: { dot: IntegrationDot }) => <StatusDot tone={dot.tone} label={dot.label} />;

/** One section per git host kind the board knows (GitHub today): its CLI, the hosts it is signed in to, and polling. */
export function GitHostsSection({
  settings,
  statuses,
}: {
  settings: AppSettings;
  statuses: readonly GitHostStatus[] | undefined;
}) {
  // While the status loads, GitHub's section shows as checking, so the page doesn't jump when it arrives.
  const shown = statuses ?? [undefined];
  return (
    <>
      {shown.map((status, i) => (
        <GitHostSection
          key={status?.kind ?? "loading"}
          settings={settings}
          status={status}
          withPolling={i === shown.length - 1}
        />
      ))}
    </>
  );
}

function GitHostSection({
  settings,
  status,
  withPolling,
}: {
  settings: AppSettings;
  status: GitHostStatus | undefined;
  /** Polling is one setting for every host, shown once, under the last. */
  withPolling: boolean;
}) {
  const updateSettings = useUpdateSettings();
  const host = gitHostDefinition(status?.kind ?? "github");
  const { cli } = host;
  const description =
    status === undefined
      ? `Checking the ${cli.label}...`
      : !status.available
        ? `${cli.name} isn't installed. ${host.terminology.short} links still work, without live status.`
        : !status.authenticated
          ? (status.error ?? `${cli.name} isn't signed in. Run \`${cli.loginCommand()}\`.`)
          : `${host.terminology.short} status and merging use the account ${cli.name} is signed in with.`;
  return (
    // The ids are GitHub's, the one kind there is: the settings search finds rows by their literal ids. A second kind
    // gets ids of its own here and entries in settingsIndex.
    <SettingsSection id="integrations.github.status" title={host.label} status={<Dot dot={gitHostDot(status)} />}>
      <SettingsRow
        id="integrations.github.cli"
        title={status?.version ? `${cli.label} ${status.version}` : cli.label}
        description={description}
        info={`Add a ${host.label} Enterprise host with \`${cli.loginCommand("<host>")}\`.`}
        control={
          status === undefined ? null : status.available && status.authenticated ? (
            <Badge variant="success">Ready</Badge>
          ) : (
            <Badge variant="warning">{status.available ? "Not signed in" : "Not found"}</Badge>
          )
        }
      />
      {status?.accounts.map((account) => (
        <SettingsRow
          key={account.host}
          id={`integrations.github.host-${account.host}`}
          title={account.host}
          description={
            account.authenticated
              ? `Signed in${account.login ? ` as ${account.login}` : ""}.`
              : `Sign-in expired. Run \`${cli.loginCommand(account.host)}\`.`
          }
          control={
            account.authenticated ? (
              <Badge variant="success">Signed in</Badge>
            ) : (
              <Badge variant="warning">Not signed in</Badge>
            )
          }
        />
      ))}
      {withPolling ? (
        <SettingsRow
          id="integrations.github.poll-prs"
          title={`Poll ${host.terminology.short} status`}
          description={`Refresh the state, checks and reviews of ${host.terminology.short} links every 2 minutes.`}
          info={`Covers ${host.site} and the Enterprise hosts ${cli.name} is signed in to.`}
          control={
            <Switch
              aria-label={`Poll ${host.terminology.short} status`}
              checked={settings.githubPolling}
              onCheckedChange={(checked) => updateSettings.mutate({ githubPolling: checked })}
            />
          }
        />
      ) : null}
    </SettingsSection>
  );
}
