import { BRAND, type AppSettings, type IntegrationsStatus, type T3IntegrationStatus } from "@repo/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MonitorIcon, MoonIcon, RefreshCwIcon, SunIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ProjectFavicon } from "~/components/project/ProjectFavicon";
import { SidebarStageBackdrop } from "~/components/SidebarStageBackdrop";
import {
  STAGE_BANNERS,
  type StageBannerChoice,
  type StageBannerId,
  resolveStageBanner,
} from "~/components/stage/stageBanner.logic";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { type Theme, useTheme } from "~/hooks/useTheme";
import { api } from "~/lib/api";
import { cn } from "~/lib/utils";
import { useUpdateSettings } from "~/state/mutations";
import { queryKeys, useIntegrationsStatus, useSettings } from "~/state/queries";
import { useAppearance, useDialogs } from "~/state/ui";
import { CommandSnippet, SettingsRow, SettingsSection } from "./settingsLayout";
import { useArchivedProjects, useUnarchiveProject } from "./useArchivedProjects";

const T3_TOKEN_COMMAND = "t3 auth session issue --scopes orchestration:read --token-only";
const LINK_TARGETS = [
  { value: "desktop", label: "Desktop app" },
  { value: "browser", label: "Browser" },
] as const;

/** The MCP endpoint as agents should reach it. In dev, Vite (5317) proxies to the server on 4317. */
function mcpUrl(): string {
  if (typeof window === "undefined" || window.location.port === "5317") return "http://127.0.0.1:4317/mcp";
  return `${window.location.origin}/mcp`;
}

/** App settings, opened from the palette or sidebar via useDialogs().setAppSettingsOpen(true). */
export function AppSettingsDialog() {
  const open = useDialogs((s) => s.appSettingsOpen);
  const setOpen = useDialogs((s) => s.setAppSettingsOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="max-w-2xl">{open ? <AppSettingsBody /> : null}</DialogPopup>
    </Dialog>
  );
}

function AppSettingsBody() {
  const settings = useSettings();
  const integrations = useIntegrationsStatus();
  return (
    <>
      <DialogHeader>
        <DialogTitle>Settings</DialogTitle>
        <DialogDescription>Appearance, integrations and agent setup.</DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-6">
        <AppearanceSection />
        {settings.data ? (
          <>
            <T3Section settings={settings.data} status={integrations.data?.t3} />
            <GithubSection settings={settings.data} status={integrations.data?.github} />
            <JiraSection settings={settings.data} />
          </>
        ) : (
          <p className="px-4 text-sm text-muted-foreground">
            {settings.error ? settings.error.message : "Loading settings..."}
          </p>
        )}
        <AgentsSection />
        <ArchivedProjectsSection />
      </DialogPanel>
    </>
  );
}

function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  return (
    <SettingsSection title="Appearance">
      <SettingsRow
        title="Theme"
        description="Follow the system, or pick light or dark."
        control={
          <ToggleGroup
            aria-label="Theme"
            value={[theme]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "light" || value === "dark" || value === "system") setTheme(value satisfies Theme);
            }}
          >
            <Toggle value="light">
              <SunIcon />
              Light
            </Toggle>
            <Toggle value="dark">
              <MoonIcon />
              Dark
            </Toggle>
            <Toggle value="system">
              <MonitorIcon />
              System
            </Toggle>
          </ToggleGroup>
        }
      />
      <BannerRow />
    </SettingsSection>
  );
}

function BannerRow() {
  const banner = useAppearance((s) => s.banner);
  const setBanner = useAppearance((s) => s.setBanner);
  return (
    <SettingsRow title="Sidebar banner" description="The art behind the name in the top-left corner.">
      <div role="radiogroup" aria-label="Sidebar banner" className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {STAGE_BANNERS.map((option) => (
          <BannerOption
            key={option.id}
            choice={option.id}
            preview={option.id}
            label={option.label}
            selected={banner === option.id}
            onSelect={setBanner}
          />
        ))}
        <BannerOption
          choice="rotate"
          preview={resolveStageBanner("rotate")}
          label={
            <>
              <RefreshCwIcon className="size-3" />
              Rotate daily
            </>
          }
          selected={banner === "rotate"}
          onSelect={setBanner}
        />
      </div>
    </SettingsRow>
  );
}

function BannerOption({
  choice,
  preview,
  label,
  selected,
  onSelect,
}: {
  choice: StageBannerChoice;
  preview: StageBannerId;
  label: ReactNode;
  selected: boolean;
  onSelect: (choice: StageBannerChoice) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(choice)}
      className={cn(
        "stage-ink relative flex h-12 cursor-pointer items-center overflow-hidden rounded-lg border bg-sidebar px-3 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-primary ring-1 ring-primary" : "border-border/60 hover:border-border",
      )}
    >
      <SidebarStageBackdrop banner={preview} />
      <span className="relative z-10 flex items-center gap-1.5 text-xs font-medium text-[var(--stage-ink)]">
        {label}
      </span>
    </button>
  );
}

function T3Section({ settings, status }: { settings: AppSettings; status: T3IntegrationStatus | undefined }) {
  const updateSettings = useUpdateSettings();
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const test = useMutation({
    mutationFn: () => api<T3IntegrationStatus>("/api/integrations/t3/test", { method: "POST", body: {} }),
    onSuccess: (t3) => {
      queryClient.setQueryData<IntegrationsStatus>(queryKeys.integrations, (current) =>
        current ? { ...current, t3 } : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.integrations });
    },
  });
  const detected = status?.detected ?? false;
  const live = test.data ?? status;

  function saveToken() {
    const value = token.trim();
    if (!value) return;
    updateSettings.mutate({ t3Token: value }, { onSuccess: () => setToken("") });
  }

  return (
    <SettingsSection title="T3 Code">
      <SettingsRow
        title="Connection"
        description={
          status === undefined
            ? "Checking for T3 Code..."
            : detected
              ? `${status.origin ?? "Unknown origin"}${status.label ? ` · ${status.label}` : ""}`
              : "T3 Code not detected — start T3 Code to enable thread links and import."
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
        title="Open thread links in"
        description="Where “Open in T3 Code” goes. The other target stays in the link's menu."
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
        title="Live thread status"
        description="Optional. Paste a read-only T3 token to show linked threads' status on cards. Mint one with:"
        status={
          settings.t3TokenSet ? (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-foreground/80">Token saved</span>
              {live?.liveStatus === "ok" ? <span className="text-success-foreground">Connected</span> : null}
              {live?.liveStatus === "error" ? (
                <span className="text-destructive-foreground">{live.error ?? "Connection failed"}</span>
              ) : null}
            </span>
          ) : null
        }
        control={
          <>
            <Input
              aria-label="T3 token"
              type="password"
              size="sm"
              className="sm:w-44"
              autoComplete="off"
              placeholder={settings.t3TokenSet ? "Replace token" : "Paste token"}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  saveToken();
                }
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!token.trim() || updateSettings.isPending}
              onClick={saveToken}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="mt-2 space-y-2">
          <CommandSnippet command={T3_TOKEN_COMMAND} />
          {settings.t3TokenSet ? (
            <div className="flex items-center justify-end gap-2">
              <Button
                size="xs"
                variant="ghost"
                disabled={updateSettings.isPending}
                onClick={() => updateSettings.mutate({ t3Token: null })}
              >
                Clear token
              </Button>
              <Button size="xs" variant="outline" disabled={test.isPending || !detected} onClick={() => test.mutate()}>
                {test.isPending ? "Testing…" : "Test connection"}
              </Button>
            </div>
          ) : null}
          {test.error ? <p className="text-xs text-destructive-foreground">{test.error.message}</p> : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

function GithubSection({
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
        ? "The GitHub CLI (gh) isn't installed. PR links still work, without live status."
        : !status.authenticated
          ? (status.error ?? "gh is installed but not signed in. Run `gh auth login`.")
          : "gh is installed and signed in.";
  return (
    <SettingsSection title="GitHub">
      <SettingsRow
        title="GitHub CLI"
        description={description}
        control={
          status === undefined ? null : status.available && status.authenticated ? (
            <Badge variant="success">Ready</Badge>
          ) : (
            <Badge variant="warning">{status.available ? "Not signed in" : "Not found"}</Badge>
          )
        }
      />
      <SettingsRow
        title="Poll PR status"
        description="Refresh state, checks and reviews of GitHub PR links every 2 minutes."
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

function JiraSection({ settings }: { settings: AppSettings }) {
  const updateSettings = useUpdateSettings();
  const [baseUrl, setBaseUrl] = useState(settings.jiraBaseUrl ?? "");

  function save() {
    const next = baseUrl.trim() || null;
    if (next !== settings.jiraBaseUrl) updateSettings.mutate({ jiraBaseUrl: next });
  }

  return (
    <SettingsSection title="Jira">
      <SettingsRow
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

function AgentsSection() {
  const url = mcpUrl();
  return (
    <SettingsSection title="Agents (MCP)">
      <SettingsRow title="Claude Code" description={`Register the ${BRAND.id} MCP server.`}>
        <div className="mt-2">
          <CommandSnippet command={`claude mcp add --transport http ${BRAND.id} ${url}`} />
        </div>
      </SettingsRow>
      <SettingsRow title="Codex" description={`Register the ${BRAND.id} MCP server.`}>
        <div className="mt-2">
          <CommandSnippet command={`codex mcp add ${BRAND.id} --url ${url}`} />
        </div>
      </SettingsRow>
      <SettingsRow
        title="GitHub Copilot CLI"
        description={`Register the ${BRAND.id} MCP server in ~/.copilot/mcp-config.json.`}
      >
        <div className="mt-2">
          <CommandSnippet command={`copilot mcp add --transport http ${BRAND.id} ${url}`} />
        </div>
      </SettingsRow>
      <SettingsRow
        title="GitHub Copilot (VS Code)"
        description={`Add the ${BRAND.id} MCP server to your VS Code user profile, or put the same entry under "servers" in .vscode/mcp.json.`}
      >
        <div className="mt-2">
          <CommandSnippet command={`code --add-mcp '{"name":"${BRAND.id}","type":"http","url":"${url}"}'`} />
        </div>
      </SettingsRow>
      <SettingsRow
        title="Skill"
        description={`Teaches Claude Code when to log ideas, write plans and update steps. Copy skills/${BRAND.id} from this repo to:`}
      >
        <div className="mt-2">
          <CommandSnippet command={`~/.claude/skills/${BRAND.id}`} />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

function ArchivedProjectsSection() {
  const archived = useArchivedProjects(true);
  const unarchive = useUnarchiveProject();
  const projects = archived.data ?? [];
  if (projects.length === 0) return null;
  return (
    <SettingsSection title="Archived projects">
      {projects.map((project) => (
        <SettingsRow
          key={project.id}
          title={
            <span className="flex min-w-0 items-center gap-2">
              <ProjectFavicon title={project.title} icon={project.icon} className="size-4" />
              <span className="truncate">{project.title}</span>
            </span>
          }
          description={
            project.workspaceRoot ? <span className="break-all font-mono">{project.workspaceRoot}</span> : undefined
          }
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={unarchive.isPending && unarchive.variables === project.id}
              onClick={() => unarchive.mutate(project.id)}
            >
              Restore
            </Button>
          }
        />
      ))}
    </SettingsSection>
  );
}
