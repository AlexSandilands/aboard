import {
  BRAND,
  PROVIDERS,
  type AppSettings,
  type ConnectT3Result,
  type HandoffTarget,
  type IntegrationsStatus,
  type ProviderId,
  type ProviderStatus,
  type T3IntegrationStatus,
} from "@repo/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { api } from "~/lib/api";
import { useUpdateProviders, useUpdateSettings } from "~/state/mutations";
import { queryKeys, useAgentModels } from "~/state/queries";
import { effortLabel } from "~/components/handoff/cliEffort.logic";
import { BlurInput } from "./BlurInput";
import { providerTierModels, type TierProvider } from "./modelTiers.logic";
import { patchProvider } from "./providers.logic";
import { CommandSnippet, SettingsGroup, SettingsRow, StatusLine } from "./settingsLayout";
import { useOpenSettings } from "./settingsNavigation";
import { AgentsSnippetRow, BoardSkillRow } from "./SkillSyncRows";

// The editor of one provider on Settings → Agents → Providers, in the same sections for each: Status, Connection, MCP & skill,
// Hand-off menu and Models. A section that doesn't apply to the provider is left out. Row ids are
// `agents.providers.<provider>.<row>`, written out at each use so the settings index test can find them.

/** The MCP endpoint as agents should reach it. In dev, Vite (5317) proxies to the server on 4317. */
export function mcpUrl(): string {
  if (typeof window === "undefined" || window.location.port === "5317") return "http://127.0.0.1:4317/mcp";
  return `${window.location.origin}/mcp`;
}

/** One titled part of the editor: a muted heading over a card of rows, inset like the list beside it. */
function EditorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 px-3 sm:px-4">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      <SettingsGroup>{children}</SettingsGroup>
    </section>
  );
}

export interface ProviderEditorProps {
  id: ProviderId;
  settings: AppSettings;
  status: ProviderStatus | undefined;
  /** The T3 integration's own status, which the pairing row writes into after Connect or Test. */
  t3: T3IntegrationStatus | undefined;
  recheck: () => void;
  rechecking: boolean;
}

/** The editor sections for one provider. */
export function ProviderEditor(props: ProviderEditorProps) {
  switch (props.id) {
    case "t3-code":
      return <T3Editor {...props} />;
    case "claude-code":
      return <ClaudeCodeEditor {...props} />;
    case "codex":
      return <CodexEditor {...props} />;
    case "copilot-cli":
      return <CopilotEditor {...props} />;
  }
}

// ── T3 Code ──────────────────────────────────────────────────────────────

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

function T3Editor({ settings, t3: status }: ProviderEditorProps) {
  const updateSettings = useUpdateSettings();
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  // Both write their result into the integrations cache and refresh the providers, so the dot and status follow.
  const settle = (t3: T3IntegrationStatus) => {
    queryClient.setQueryData<IntegrationsStatus>(queryKeys.integrations, (current) =>
      current ? { ...current, t3 } : current,
    );
    void queryClient.invalidateQueries({ queryKey: queryKeys.integrations });
    void queryClient.invalidateQueries({ queryKey: queryKeys.providers });
  };
  const test = useMutation({
    mutationFn: () => api<T3IntegrationStatus>("/api/integrations/t3/test", { method: "POST", body: {} }),
    onSuccess: (t3) => {
      connect.reset();
      settle(t3);
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
      settle(t3);
    },
  });
  const detected = status?.detected ?? false;
  const warning = connect.data?.warning;
  const error = connect.error ?? test.error;

  function saveToken() {
    const value = token.trim();
    if (value) connect.mutate(value);
  }

  return (
    <>
      <EditorSection title="Status">
        <SettingsRow
          id="agents.providers.t3-code.status"
          title="T3 Code app"
          description={
            status !== undefined && !detected ? "Start T3 Code to enable thread links and import." : undefined
          }
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
      </EditorSection>
      <EditorSection title="Connection">
        <SettingsRow
          id="agents.providers.t3-code.pairing"
          title="Pairing"
          description="Live thread status and starting threads from a task."
          info={<PairingHelp />}
          infoLabel="How to connect T3 Code"
          status={
            settings.t3TokenSet ? (
              <StatusLine>
                <span className="text-foreground/80">Token saved</span>
                {status?.liveStatus === "ok" ? <span className="ms-3 text-success-foreground">Connected</span> : null}
                {status?.liveStatus === "error" ? (
                  <span className="ms-3 text-destructive-foreground">{status.error ?? "Connection failed"}</span>
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
                <Button
                  size="xs"
                  variant="outline"
                  disabled={test.isPending || !detected}
                  onClick={() => test.mutate()}
                >
                  {test.isPending ? "Testing…" : "Test connection"}
                </Button>
              </div>
            ) : null}
            {error ? <p className="text-xs text-destructive-foreground">{error.message}</p> : null}
            {warning ? <p className="text-xs text-warning-foreground">{warning}</p> : null}
          </div>
        </SettingsRow>
        <SettingsRow
          id="agents.providers.t3-code.open-links-in"
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
          id="agents.providers.t3-code.agent-threads"
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
      </EditorSection>
      <EditorSection title="Hand-off menu">
        <HandoffMenuRow
          id="agents.providers.t3-code.handoff-menus"
          target="t3-code"
          what="New T3 Code thread"
          settings={settings}
        />
      </EditorSection>
      <EditorSection title="Models">
        <ProviderModelsRow id="agents.providers.t3-code.models" provider="t3" settings={settings} />
      </EditorSection>
    </>
  );
}

// ── CLI providers ────────────────────────────────────────────────────────

/** What the CLI check found, on the row's status line. */
function CliStatus({ cli }: { cli: ProviderStatus["cli"] | undefined }) {
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
function McpStatus({ mcp }: { mcp: ProviderStatus["mcp"] | undefined }) {
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

/** The models scan, for a provider that lists its models. */
function ModelsStatus({ models }: { models: ProviderStatus["models"] | undefined }) {
  if (!models) return null;
  return models.error ? (
    <StatusLine badge={<Badge variant="warning">Not listed</Badge>}>{models.error}</StatusLine>
  ) : (
    <StatusLine badge={<Badge variant="success">{models.count} models</Badge>} />
  );
}

/** The CLI check with its Re-check, the first row of a CLI provider. */
function CliStatusRow({ id, status, recheck, rechecking }: ProviderEditorProps & { id: ProviderId }) {
  const info = PROVIDERS[id];
  return (
    <SettingsRow
      id={`agents.providers.${id}.status`}
      title={`${info.label} CLI`}
      status={status ? <CliStatus cli={status.cli} /> : "Checking…"}
      control={
        <Button size="sm" variant="outline" disabled={rechecking} onClick={recheck}>
          {rechecking ? "Checking…" : "Re-check"}
        </Button>
      }
    >
      {status?.models ? (
        <div className="mt-2 text-xs text-muted-foreground">
          <ModelsStatus models={status.models} />
        </div>
      ) : null}
    </SettingsRow>
  );
}

/** The CLI path the board runs for the provider; empty looks its name up on PATH. */
function CliPathRow({
  id,
  rowId,
  title,
  info,
  settings,
}: {
  id: ProviderId;
  rowId: string;
  title: string;
  info: string;
  settings: AppSettings;
}) {
  const updateProviders = useUpdateProviders();
  const cli = PROVIDERS[id].cli ?? "";
  const path = settings.providers.find((p) => p.id === id)?.cliPath ?? "";
  return (
    <SettingsRow
      id={rowId}
      title={title}
      description={`Empty uses ${cli} from your PATH.`}
      info={info}
      control={
        <BlurInput
          aria-label={title}
          size="sm"
          className="sm:w-56"
          placeholder={cli}
          value={path}
          onSave={(next) => updateProviders.mutate((list) => patchProvider(list, id, { cliPath: next.trim() || null }))}
        />
      }
    />
  );
}

/** The command that registers the board's MCP server with a CLI, and what the check found. */
function McpRow({
  id,
  rowId,
  title,
  info,
  status,
}: {
  id: ProviderId;
  rowId: string;
  title: string;
  info?: string;
  status: ProviderStatus | undefined;
}) {
  const command = PROVIDERS[id].mcpCommand?.(BRAND.id, mcpUrl());
  return (
    <SettingsRow
      id={rowId}
      title={title}
      description="Register the MCP server."
      info={info}
      // Without a CLI the board can't ask, and Codex's config may name it anyway: show what was found only then.
      status={status?.cli?.found ? <McpStatus mcp={status.mcp} /> : undefined}
    >
      {command ? (
        <div className="mt-2">
          <CommandSnippet command={command} />
        </div>
      ) : null}
    </SettingsRow>
  );
}

function ClaudeCodeEditor(props: ProviderEditorProps) {
  const { settings, status } = props;
  return (
    <>
      <EditorSection title="Status">
        <CliStatusRow {...props} id="claude-code" />
      </EditorSection>
      <EditorSection title="Connection">
        <CliPathRow
          id="claude-code"
          rowId="agents.providers.claude-code.cli-path"
          title="Claude Code CLI path"
          info="The board runs it headless for the board reviewer, issue import and the settings Ask, and opens it for a new Claude Code session."
          settings={settings}
        />
      </EditorSection>
      <EditorSection title="MCP & skill">
        <McpRow id="claude-code" rowId="agents.providers.claude-code.mcp" title="MCP server" status={status} />
        <BoardSkillRow id="agents.providers.claude-code.skill" harness="claude" title="Claude Code" />
      </EditorSection>
      <EditorSection title="Hand-off menu">
        <HandoffMenuRow
          id="agents.providers.claude-code.handoff-menus"
          target="claude-code"
          what="New Claude Code session"
          settings={settings}
        />
      </EditorSection>
      <EditorSection title="Models">
        <ProviderModelsRow id="agents.providers.claude-code.models" provider="claude-code" settings={props.settings} />
      </EditorSection>
    </>
  );
}

function CopilotEditor(props: ProviderEditorProps) {
  const { settings, status } = props;
  const url = mcpUrl();
  return (
    <>
      <EditorSection title="Status">
        <CliStatusRow {...props} id="copilot-cli" />
      </EditorSection>
      <EditorSection title="Connection">
        <CliPathRow
          id="copilot-cli"
          rowId="agents.providers.copilot-cli.cli-path"
          title="Copilot CLI path"
          info="What the board opens for a new Copilot CLI session."
          settings={settings}
        />
      </EditorSection>
      <EditorSection title="MCP & skill">
        <McpRow
          id="copilot-cli"
          rowId="agents.providers.copilot-cli.mcp"
          title="Copilot CLI"
          info="Adds it to ~/.copilot/mcp-config.json."
          status={status}
        />
        <SettingsRow
          id="agents.providers.copilot-cli.vscode"
          title="VS Code"
          description="Add the MCP server to your VS Code user profile."
          info={'Or put the same entry under "servers" in .vscode/mcp.json.'}
        >
          <div className="mt-2">
            <CommandSnippet command={`code --add-mcp '{"name":"${BRAND.id}","type":"http","url":"${url}"}'`} />
          </div>
        </SettingsRow>
        <BoardSkillRow id="agents.providers.copilot-cli.skill" harness="copilot" title="Copilot" />
      </EditorSection>
      <EditorSection title="Hand-off menu">
        <HandoffMenuRow
          id="agents.providers.copilot-cli.handoff-menus"
          target="copilot-cli"
          what="New Copilot CLI session"
          settings={settings}
        />
      </EditorSection>
      <EditorSection title="Models">
        <ProviderModelsRow id="agents.providers.copilot-cli.models" provider="copilot-cli" settings={props.settings} />
      </EditorSection>
    </>
  );
}

function CodexEditor(props: ProviderEditorProps) {
  const { settings, status } = props;
  return (
    <>
      <EditorSection title="Status">
        <CliStatusRow {...props} id="codex" />
      </EditorSection>
      <EditorSection title="Connection">
        <CliPathRow
          id="codex"
          rowId="agents.providers.codex.cli-path"
          title="Codex CLI path"
          info="What the board opens for a new Codex session, what headless Autopilot runs start for a model that runs on Codex, and what Open in terminal resumes a Codex session with."
          settings={settings}
        />
      </EditorSection>
      <EditorSection title="MCP & skill">
        <McpRow
          id="codex"
          rowId="agents.providers.codex.mcp"
          title="MCP server"
          info="Adds it to ~/.codex/config.toml."
          status={status}
        />
        <BoardSkillRow id="agents.providers.codex.skill" harness="codex" title="Codex" />
        <AgentsSnippetRow id="agents.providers.codex.snippet" />
      </EditorSection>
      <EditorSection title="Hand-off menu">
        <HandoffMenuRow
          id="agents.providers.codex.handoff-menus"
          target="codex"
          what="New Codex session"
          settings={settings}
        />
      </EditorSection>
      <EditorSection title="Models">
        <ProviderModelsRow id="agents.providers.codex.models" provider="codex" settings={props.settings} />
      </EditorSection>
    </>
  );
}

// ── Shared rows ──────────────────────────────────────────────────────────

/**
 * Whether the board's hand-off menus offer to start this provider. Off hides it for someone who has it added but
 * doesn't want it offered; sessions already linked still reopen.
 */
function HandoffMenuRow({
  id,
  target,
  what,
  settings,
}: {
  id: string;
  target: HandoffTarget;
  what: string;
  settings: AppSettings;
}) {
  const updateSettings = useUpdateSettings();
  return (
    <SettingsRow
      id={id}
      title="Show in hand-off menus"
      description={`Offer “${what}…” on tasks and lanes when it can start.`}
      info="Off hides it from the hand-off, Plan tasks, Suggest epics and Fix PR menus. Linked sessions and threads still open."
      control={
        <Switch
          aria-label={`Show ${what} in hand-off menus`}
          checked={settings.handoffMenus[target]}
          onCheckedChange={(checked) => updateSettings.mutate({ handoffMenus: { [target]: checked } })}
        />
      }
    />
  );
}

/**
 * The provider's models: what each tier runs on it, and for a CLI the models its scan lists. They are set on the
 * Models page, which the button opens.
 */
function ProviderModelsRow({ id, provider, settings }: { id: string; provider: TierProvider; settings: AppSettings }) {
  const openSettings = useOpenSettings();
  const scanned = useAgentModels(provider !== "t3");
  const listed = provider === "t3" ? [] : (scanned.data?.harnesses.find((h) => h.harness === provider)?.models ?? []);
  // What a tier with no model runs, when the scan says (Codex's `isDefault`).
  const fallback = listed.find((model) => model.isDefault);
  return (
    <SettingsRow
      id={id}
      title="Models"
      description="What each tier runs on here. Set them, and which provider runs each operation, under Models and Operations."
      status={
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          {providerTierModels(settings.modelTiers, provider).map((tier) => (
            <span key={tier.tier}>
              {tier.label}:{" "}
              <span className={tier.model ? "font-mono text-foreground/80" : undefined}>
                {tier.model ?? (fallback ? `default (${fallback.value})` : "default")}
              </span>
              {tier.effort ? `, ${effortLabel(tier.effort).toLowerCase()}` : null}
              {tier.preferred ? " (preferred)" : null}
            </span>
          ))}
        </span>
      }
      control={
        <Button size="sm" variant="outline" onClick={() => openSettings("agents.models.tiers.list")}>
          Open Models
        </Button>
      }
    >
      {listed.length > 0 ? (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {listed.length} listed:{" "}
          {listed.map((model, index) => (
            <span key={model.value}>
              {index > 0 ? ", " : null}
              <span className="font-mono" title={model.description ?? undefined}>
                {model.value}
              </span>
            </span>
          ))}
        </p>
      ) : null}
    </SettingsRow>
  );
}
