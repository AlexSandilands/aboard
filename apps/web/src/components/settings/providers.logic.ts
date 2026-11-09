// Pure helpers for Settings → Agents → Providers: what each provider's dot says, what the list and the Add provider dialog
// show, and the CLI checks the menus read. Detection comes from `GET /api/providers` (useProviders).
import {
  AgentHarness,
  PROVIDERS,
  ProviderId,
  type AgentCliStatus,
  type AppSettings,
  type ProviderSetting,
  type ProviderStatus,
  type ProvidersStatus,
  type T3IntegrationStatus,
  t3ProviderStatus,
} from "@repo/contracts";
import type { IntegrationDot, IntegrationTone } from "./integrations.logic";

const dot = (tone: IntegrationTone, label: string): IntegrationDot => ({ tone, label });

/** T3 Code: green once a saved token connects, amber when something is wrong, grey when it isn't set up. */
export function t3Dot(t3: ProviderStatus["t3"] | undefined): IntegrationDot {
  if (!t3) return dot("muted", "Checking");
  if (!t3.detected) return dot("muted", "Not detected");
  if (!t3.tokenSet) return dot("muted", "Detected, not connected");
  if (t3.liveStatus === "error") return dot("warning", t3.error ?? "Connection failed");
  return dot("success", t3.liveStatus === "ok" ? "Connected" : "Token saved");
}

/**
 * A CLI provider: green when its CLI runs and the board's MCP server is registered with it, amber with the reason when
 * either is missing. Whether the harness reports the server as connected is detail, not a condition: it can't always
 * tell.
 */
export function cliDot(
  name: string,
  status: Pick<ProviderStatus, "cli" | "mcp"> | undefined,
  /** The request for the status failed, so there is none to wait for. */
  failed = false,
): IntegrationDot {
  if (!status?.cli) return failed ? dot("warning", `Couldn't check ${name}`) : dot("muted", "Checking");
  if (!status.cli.found) {
    return dot("warning", `${name} CLI not working${status.cli.error ? `: ${status.cli.error}` : ""}`);
  }
  const mcp = status.mcp;
  if (!mcp) return dot("success", "Ready");
  if (!mcp.registered) return dot("warning", "MCP server not registered");
  // Added for one project only: `claude mcp list` can't confirm it, and it isn't there in other folders.
  if (mcp.scope === "local" && mcp.connected === null) {
    return dot("warning", "MCP server is registered for one project only: add it with --scope user");
  }
  if (mcp.connected === false) {
    return dot("success", `Ready, but ${name} reports the MCP server as not connected`);
  }
  return dot("success", "Ready");
}

/** A provider's dot in the list and its editor: grey while switched off, else what detection found. */
export function providerDot(
  id: ProviderId,
  status: ProviderStatus | undefined,
  setting: Pick<ProviderSetting, "enabled"> | undefined,
  failed = false,
): IntegrationDot {
  if (setting && !setting.enabled) return dot("muted", "Off");
  if (id === "t3-code")
    return status ? t3Dot(status.t3) : failed ? dot("warning", "Couldn't check T3 Code") : t3Dot(undefined);
  return cliDot(PROVIDERS[id].label, status, failed);
}

/** The line under a provider's name in the list: its CLI version, T3 Code's origin, or why neither is there. */
export function providerSubtitle(id: ProviderId, status: ProviderStatus | undefined): string | null {
  if (!status) return null;
  if (id === "t3-code") {
    if (!status.t3?.detected) return "Not running";
    return status.t3.label ?? status.t3.origin ?? "Running";
  }
  if (!status.cli?.found) return "CLI not found";
  return status.cli.version ? versionOf(status.cli.version) : "Installed";
}

/** "2.1.30 (Claude Code)" → "v2.1.30": the number, when the CLI prints one. */
export function versionOf(raw: string): string {
  const match = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(raw);
  return match ? `v${match[0]}` : raw;
}

/** What the Add provider dialog says about a provider not added yet: whether this machine has it. */
export function detectionLabel(
  id: ProviderId,
  status: ProviderStatus | undefined,
): {
  tone: IntegrationTone;
  label: string;
} {
  if (!status) return { tone: "muted", label: "Checking…" };
  if (id === "t3-code") {
    return status.t3?.detected ? { tone: "success", label: "Running" } : { tone: "muted", label: "Not running" };
  }
  if (status.cli?.found) {
    return {
      tone: "success",
      label: status.cli.version ? `Installed · ${versionOf(status.cli.version)}` : "Installed",
    };
  }
  return { tone: "muted", label: "Not found" };
}

/** The providers the Add provider dialog offers: every one not added yet, in the registry's order. */
export function addableProviders(providers: readonly Pick<ProviderSetting, "id">[]): ProviderId[] {
  return ProviderId.options.filter((id) => !providers.some((p) => p.id === id));
}

/** The list after adding a provider: on, with no CLI path of its own, at the end. Adding one already there is a no-op. */
export function withProvider(providers: readonly ProviderSetting[], id: ProviderId): ProviderSetting[] {
  if (providers.some((p) => p.id === id)) return [...providers];
  return [...providers, { id, enabled: true, cliPath: null }];
}

/** The list with one provider's entry changed. */
export function patchProvider(
  providers: readonly ProviderSetting[],
  id: ProviderId,
  patch: Partial<Omit<ProviderSetting, "id">>,
): ProviderSetting[] {
  return providers.map((p) => (p.id === id ? { ...p, ...patch } : p));
}

/** The list without a provider. */
export const withoutProvider = (providers: readonly ProviderSetting[], id: ProviderId): ProviderSetting[] =>
  providers.filter((p) => p.id !== id);

/**
 * The provider the editor shows: the one in `?provider=` (a link or a search result can name one not added yet, which
 * the editor offers to add), else the first added, else none (the empty state).
 */
export function selectedProvider(
  providers: readonly Pick<ProviderSetting, "id">[],
  requested: string | null | undefined,
): ProviderId | null {
  const parsed = ProviderId.safeParse(requested);
  return parsed.success ? parsed.data : (providers[0]?.id ?? null);
}

/**
 * What stops working when a provider is switched off or removed, for the confirm. Sessions and threads already
 * linked to tasks still open; the CLI path is kept while it is only switched off.
 */
export function providerLosses(id: ProviderId): string[] {
  switch (id) {
    case "t3-code":
      return [
        "“New T3 Code thread” leaves the hand-off, Plan tasks and Suggest epics menus.",
        "T3 Code models leave the model pickers.",
      ];
    case "claude-code":
      return [
        "“New Claude Code session” leaves the hand-off menus and the launch and plan dialogs.",
        "Claude Code models leave the tier and custom-model pickers, and the Ask box in Settings stops.",
      ];
    case "codex":
      return [
        "“New Codex session” leaves the hand-off menus and the launch and plan dialogs.",
        "Codex leaves the Headless runs select and the tier and custom-model pickers.",
      ];
    case "copilot-cli":
      return [
        "“New Copilot CLI session” leaves the hand-off menus and the launch and plan dialogs.",
        "Copilot models leave the tier and custom-model pickers.",
      ];
  }
}

/**
 * The cached providers with T3 Code's part replaced by a fresh integration status (the `integrations.changed` event),
 * so an open page follows T3 starting or stopping without re-running the CLI and MCP checks. The event doesn't carry
 * whether a token is saved, so that stays as cached. Nothing cached yet stays nothing: the first fetch will be current.
 */
export function withT3Status(
  status: ProvidersStatus | undefined,
  t3: T3IntegrationStatus,
): ProvidersStatus | undefined {
  if (!status) return status;
  return {
    ...status,
    providers: status.providers.map((p) =>
      p.id === "t3-code" ? { ...p, t3: t3ProviderStatus(t3, p.t3?.tokenSet ?? false) } : p,
    ),
  };
}

/**
 * Each harness's CLI check, for the menus and the session rows. Whether the CLI is found doesn't depend on the
 * provider being added: a linked session still reopens. What the menus offer is filtered by handoffClis.
 */
export function agentClisOf(status: ProvidersStatus | undefined): AgentCliStatus[] | undefined {
  if (!status) return undefined;
  return AgentHarness.options.map((harness) => {
    const cli = status.providers.find((p) => p.id === harness)?.cli;
    return { harness, available: cli?.found ?? false, path: cli?.path ?? null };
  });
}

/** The harnesses the user added and switched on: what the tier and custom-model pickers offer. */
export const activeHarnesses = (settings: Pick<AppSettings, "providers"> | undefined): AgentHarness[] =>
  AgentHarness.options.filter((harness) => settings?.providers.some((p) => p.id === harness && p.enabled));

/**
 * Why the settings Ask can't run, or null when it can (or it isn't known yet: a miss only shows once asked). It runs
 * Claude Code headless, so it needs that provider added, on, and its CLI found.
 */
export function askUnavailableReason(
  settings: Pick<AppSettings, "providers"> | undefined,
  claude: ProviderStatus | undefined,
): string | null {
  if (!settings) return null;
  const setting = settings.providers.find((p) => p.id === "claude-code");
  if (!setting) return "Add Claude Code in Settings → Agents → Providers to ask in your own words.";
  if (!setting.enabled) return "Claude Code is switched off in Settings → Agents → Providers.";
  if (!claude?.cli || claude.cli.found) return null;
  return setting.cliPath
    ? `The Claude Code CLI wasn't found at ${setting.cliPath}.`
    : "The Claude Code CLI (claude) wasn't found on your PATH.";
}
