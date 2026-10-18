import {
  BRAND,
  type AgentIntegrationStatus,
  type AppSettings,
  type ConnectT3Result,
  type IntegrationsStatus,
  type T3IntegrationStatus,
} from "@repo/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { api } from "~/lib/api";
import { useRecheckAgentIntegrations, useUpdateSettings } from "~/state/mutations";
import { queryKeys, useAgentIntegrations } from "~/state/queries";
import { BlurInput } from "./BlurInput";
import { agentDot, githubDot, jiraDot, SNIPPET_DOT, t3Dot, type IntegrationDot } from "./integrations.logic";
import { CommandSnippet, SettingsRow, SettingsSection, StatusDot, StatusLine } from "./settingsLayout";
import { useOpenSettings } from "./settingsNavigation";

const Dot = ({ dot }: { dot: IntegrationDot }) => <StatusDot tone={dot.tone} label={dot.label} />;

/** How to get a pairing link, for the info button of the connection row. */
function PairingHelp() {
  return (
    <>
      <ol className="list-decimal space-y-1 ps-4">
        <li>In T3 Code, open Settings → Connections → Create link.</li>
        <li>Allow “View environment” and “Operate tasks”.</li>
        <li>Paste the link here within 5 minutes and press Connect.</li>
      </ol>
      <p className="mt-2 text-muted-foreground">A token from the t3 CLI works too.</p>
    </>
  );
}

const LINK_TARGETS = [
  { value: "desktop", label: "Desktop app" },
  { value: "browser", label: "Browser" },
] as const;

/** The MCP endpoint as agents should reach it. In dev, Vite (5317) proxies to the server on 4317. */
function mcpUrl(): string {
  if (typeof window === "undefined" || window.location.port === "5317") return "http://127.0.0.1:4317/mcp";
  return `${window.location.origin}/mcp`;
}

export function T3Section({ settings, status }: { settings: AppSettings; status: T3IntegrationStatus | undefined }) {
  const updateSettings = useUpdateSettings();
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const test = useMutation({
    mutationFn: () => api<T3IntegrationStatus>("/api/integrations/t3/test", { method: "POST", body: {} }),
    onSuccess: (t3) => {
      connect.reset();
      queryClient.setQueryData<IntegrationsStatus>(queryKeys.integrations, (current) =>
        current ? { ...current, t3 } : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.integrations });
    },
  });
  // The server exchanges a pairing link for a token (or saves a CLI token as is), then checks it.
  const connect = useMutation({
    mutationFn: (value: string) =>
      api<ConnectT3Result>("/api/integrations/t3/connect", { method: "POST", body: { value } }),
    onSuccess: ({ settings: saved, t3 }) => {
      setToken("");
      test.reset();
      queryClient.setQueryData(queryKeys.settings, saved);
      queryClient.setQueryData<IntegrationsStatus>(queryKeys.integrations, (current) =>
        current ? { ...current, t3 } : current,
      );
    },
  });
  const detected = status?.detected ?? false;
  // Both mutations write their result into the integrations cache, so the live status stays current.
  const live = status;
  const warning = connect.data?.warning;
  const error = connect.error ?? test.error;

  function saveToken() {
    const value = token.trim();
    if (value) connect.mutate(value);
  }

  return (
    <SettingsSection
      id="integrations.t3-code.status"
      title="T3 Code"
      status={<Dot dot={t3Dot(status, settings.t3TokenSet)} />}
    >
      <SettingsRow
        id="integrations.t3-code.connection"
        title="Connection"
        description={status !== undefined && !detected ? "Start T3 Code to enable thread links and import." : undefined}
        status={
          status === undefined ? (
            "Checking for T3 Code..."
          ) : detected ? (
            <StatusLine>
              {status.origin ?? "Unknown origin"}
              {status.label ? ` · ${status.label}` : ""}
            </StatusLine>
          ) : null
        }
        control={
          status === undefined ? null : detected ? (
            <Badge variant="success">Detected</Badge>
          ) : (
            <Badge variant="warning">Not detected</Badge>
          )
        }
      />
      <SettingsRow
        id="integrations.t3-code.open-links-in"
        title="Open thread links in"
        description="Where “Open in T3 Code” goes."
        info="The other target stays in the link's menu."
        control={
          <Select
            items={LINK_TARGETS}
            value={settings.t3LinkTarget}
            onValueChange={(value) => {
              if (value === "desktop" || value === "browser") updateSettings.mutate({ t3LinkTarget: value });
            }}
          >
            <SelectTrigger size="sm" className="sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {LINK_TARGETS.map((target) => (
                <SelectItem key={target.value} value={target.value}>
                  {target.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        id="integrations.t3-code.pairing"
        title="T3 connection"
        description="Optional. Live thread status and starting threads from a task."
        info={<PairingHelp />}
        infoLabel="How to connect T3 Code"
        status={
          settings.t3TokenSet ? (
            <StatusLine>
              <span className="text-foreground/80">Token saved</span>
              {live?.liveStatus === "ok" ? <span className="ms-3 text-success-foreground">Connected</span> : null}
              {live?.liveStatus === "error" ? (
                <span className="ms-3 text-destructive-foreground">{live.error ?? "Connection failed"}</span>
              ) : null}
            </StatusLine>
          ) : null
        }
        control={
          <>
            <Input
              aria-label="T3 pairing link or token"
              type="password"
              size="sm"
              className="sm:w-44"
              autoComplete="off"
              placeholder={settings.t3TokenSet ? "Replace with a pairing link" : "Paste pairing link"}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  saveToken();
                }
              }}
            />
            <Button size="sm" variant="outline" disabled={!token.trim() || connect.isPending} onClick={saveToken}>
              {connect.isPending ? "Connecting…" : "Connect"}
            </Button>
          </>
        }
      >
        <div className="mt-2 space-y-2">
          {settings.t3TokenSet ? (
            <div className="flex items-center justify-end gap-2">
              <Button
                size="xs"
                variant="ghost"
                disabled={updateSettings.isPending}
                onClick={() => updateSettings.mutate({ t3Token: null }, { onSuccess: () => connect.reset() })}
              >
                Clear token
              </Button>
              <Button size="xs" variant="outline" disabled={test.isPending || !detected} onClick={() => test.mutate()}>
                {test.isPending ? "Testing…" : "Test connection"}
              </Button>
            </div>
          ) : null}
          {error ? <p className="text-xs text-destructive-foreground">{error.message}</p> : null}
          {warning ? <p className="text-xs text-warning-foreground">{warning}</p> : null}
        </div>
      </SettingsRow>
      <SettingsRow
        id="integrations.t3-code.agent-threads"
        title="Let agents start threads"
        description="Let an agent orchestrating an epic start its tasks in new T3 threads."
        info="Each thread gets a new worktree, the task's suggested model or T3's default, and no more access than T3's default. The agent may also message them in your name. Off: it uses subagents or gives you prompts to paste."
        control={
          <Switch
            aria-label="Let agents start threads"
            checked={settings.agentT3Threads}
            onCheckedChange={(checked) => updateSettings.mutate({ agentT3Threads: checked })}
          />
        }
      />
      <ModelsPerTierRow section="t3-code" />
    </SettingsSection>
  );
}

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

export function JiraSection({ settings }: { settings: AppSettings }) {
  const updateSettings = useUpdateSettings();
  const [baseUrl, setBaseUrl] = useState(settings.jiraBaseUrl ?? "");

  function save() {
    const next = baseUrl.trim() || null;
    if (next !== settings.jiraBaseUrl) updateSettings.mutate({ jiraBaseUrl: next });
  }

  return (
    <SettingsSection id="integrations.jira.status" title="Jira" status={<Dot dot={jiraDot(settings.jiraBaseUrl)} />}>
      <SettingsRow
        id="integrations.jira.base-url"
        title="Base URL"
        description="Used to link keys like ABC-123."
        control={
          <Input
            aria-label="Jira base URL"
            size="sm"
            className="sm:w-64"
            placeholder="https://example.atlassian.net"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            onBlur={save}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
        }
      />
    </SettingsSection>
  );
}

/** What the CLI check found, on the row's status line. */
function CliStatus({ cli }: { cli: AgentIntegrationStatus["cli"] | undefined }) {
  if (!cli) return null;
  return cli.found ? (
    <StatusLine badge={<Badge variant="success">Found</Badge>}>
      {cli.version} · <span className="font-mono">{cli.path}</span>
    </StatusLine>
  ) : (
    <StatusLine badge={<Badge variant="warning">Not working</Badge>}>{cli.error}</StatusLine>
  );
}

/** What the MCP check found: registered under which name and scope, and whether the harness says it connects. */
function McpStatus({ mcp }: { mcp: AgentIntegrationStatus["mcp"] | undefined }) {
  if (!mcp) return null;
  if (!mcp.registered) {
    return <StatusLine badge={<Badge variant="warning">Not registered</Badge>}>{mcp.detail}</StatusLine>;
  }
  const where = [mcp.name, mcp.scope && `${mcp.scope} scope`].filter(Boolean).join(", ");
  return (
    <StatusLine
      badge={
        <Badge variant={mcp.connected === false ? "warning" : "success"}>
          {mcp.connected === false ? "Not connected" : "Registered"}
        </Badge>
      }
    >
      {where}
      {mcp.connected === false && mcp.detail ? ` · ${mcp.detail}` : null}
    </StatusLine>
  );
}

/**
 * Claude Code: register the MCP server, install the skill, and the CLI the board runs headless (the board reviewer
 * and issue import).
 */
export function ClaudeCodeSection({ settings }: { settings: AppSettings }) {
  const url = mcpUrl();
  const updateSettings = useUpdateSettings();
  const queryClient = useQueryClient();
  const recheck = useRecheckAgentIntegrations();
  const integrations = useAgentIntegrations();
  const claude = integrations.data?.harnesses.find((h) => h.harness === "claude-code");
  return (
    <SettingsSection
      id="integrations.claude-code.status"
      title="Claude Code"
      status={<Dot dot={agentDot("Claude Code", claude, integrations.isError)} />}
    >
      <SettingsRow
        id="integrations.claude-code.mcp"
        title="MCP server"
        description="Register the MCP server."
        status={<McpStatus mcp={claude?.mcp} />}
      >
        <div className="mt-2">
          <CommandSnippet command={`claude mcp add --scope user --transport http ${BRAND.id} ${url}`} />
        </div>
      </SettingsRow>
      <SettingsRow
        id="integrations.claude-code.skill"
        title="Skill"
        description={`Copy skills/${BRAND.id} from this repo to:`}
        info="Teaches Claude Code when to add to the backlog, write plans and update steps."
      >
        <div className="mt-2">
          <CommandSnippet command={`~/.claude/skills/${BRAND.id}`} />
        </div>
      </SettingsRow>
      <SettingsRow
        id="integrations.claude-code.cli-path"
        title="Claude Code CLI"
        description="Empty uses claude from your PATH."
        info="The board runs it headless for the board reviewer and issue import, and opens it for a new Claude Code session."
        status={<CliStatus cli={claude?.cli} />}
        control={
          <>
            <BlurInput
              aria-label="Claude Code CLI"
              size="sm"
              className="sm:w-56"
              placeholder="claude"
              value={settings.headlessReviewCli ?? ""}
              onSave={(next) =>
                updateSettings.mutate(
                  { headlessReviewCli: next.trim() || null },
                  {
                    onSuccess: () => {
                      void queryClient.invalidateQueries({ queryKey: queryKeys.agentClis });
                      void queryClient.invalidateQueries({ queryKey: queryKeys.agentIntegrations });
                    },
                  },
                )
              }
            />
            <Button size="sm" variant="outline" disabled={recheck.isPending} onClick={() => recheck.mutate()}>
              Re-check
            </Button>
          </>
        }
      />
      <ModelsPerTierRow section="claude-code" />
    </SettingsSection>
  );
}

/**
 * A one-line pointer from an integration to the Model tiers page, where its model per suggested tier is set. The same
 * row sits in each integration that has one, so none of them looks like it is missing the setting.
 */
function ModelsPerTierRow({ section }: { section: string }) {
  const openSettings = useOpenSettings();
  return (
    <SettingsRow
      id={`integrations.${section}.models`}
      title="Models per tier"
      control={
        <Button size="sm" variant="outline" onClick={() => openSettings("models")}>
          Open Model tiers
        </Button>
      }
    />
  );
}

/** GitHub Copilot: the MCP server for the CLI and for VS Code, and the CLI new Copilot sessions open. */
export function CopilotSection({ settings }: { settings: AppSettings }) {
  const url = mcpUrl();
  const updateSettings = useUpdateSettings();
  const queryClient = useQueryClient();
  const recheck = useRecheckAgentIntegrations();
  const integrations = useAgentIntegrations();
  const copilot = integrations.data?.harnesses.find((h) => h.harness === "copilot-cli");
  return (
    <SettingsSection
      id="integrations.copilot.status"
      title="GitHub Copilot"
      status={<Dot dot={agentDot("Copilot", copilot, integrations.isError)} />}
    >
      <SettingsRow
        id="integrations.copilot.cli"
        title="Copilot CLI"
        description="Register the MCP server."
        info="Adds it to ~/.copilot/mcp-config.json."
        status={<McpStatus mcp={copilot?.mcp} />}
      >
        <div className="mt-2">
          <CommandSnippet command={`copilot mcp add --transport http ${BRAND.id} ${url}`} />
        </div>
      </SettingsRow>
      <SettingsRow
        id="integrations.copilot.vscode"
        title="VS Code"
        description="Add the MCP server to your VS Code user profile."
        info={'Or put the same entry under "servers" in .vscode/mcp.json.'}
      >
        <div className="mt-2">
          <CommandSnippet command={`code --add-mcp '{"name":"${BRAND.id}","type":"http","url":"${url}"}'`} />
        </div>
      </SettingsRow>
      <SettingsRow
        id="integrations.copilot.cli-path"
        title="Copilot CLI path"
        description="Empty uses copilot from your PATH."
        info="What the board opens for a new Copilot CLI session."
        status={<CliStatus cli={copilot?.cli} />}
        control={
          <>
            <BlurInput
              aria-label="Copilot CLI path"
              size="sm"
              className="sm:w-56"
              placeholder="copilot"
              value={settings.copilotCli ?? ""}
              onSave={(next) =>
                updateSettings.mutate(
                  { copilotCli: next.trim() || null },
                  {
                    onSuccess: () => {
                      void queryClient.invalidateQueries({ queryKey: queryKeys.agentClis });
                      void queryClient.invalidateQueries({ queryKey: queryKeys.agentIntegrations });
                    },
                  },
                )
              }
            />
            <Button size="sm" variant="outline" disabled={recheck.isPending} onClick={() => recheck.mutate()}>
              Re-check
            </Button>
          </>
        }
      />
      <ModelsPerTierRow section="copilot" />
    </SettingsSection>
  );
}

export function CodexSection() {
  return (
    <SettingsSection id="integrations.codex.status" title="Codex" status={<Dot dot={SNIPPET_DOT} />}>
      <SettingsRow id="integrations.codex.mcp" title="MCP server" description="Register the MCP server.">
        <div className="mt-2">
          <CommandSnippet command={`codex mcp add ${BRAND.id} --url ${mcpUrl()}`} />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
