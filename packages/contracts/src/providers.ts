import { z } from "zod";
import type { AgentHarness } from "./agentSessions.ts";
import type { HandoffTarget, T3IntegrationStatus } from "./schemas.ts";

// The providers the board works with: T3 Code and the CLI harnesses it starts. A provider is opt-in: the user adds it
// in Settings → Agents → Providers, and one that isn't added shows nowhere else. Detection (CLI, MCP, T3, models) has one
// source, `GET /api/providers`. See docs/features/agent-sessions.md and ADR 0011.

export const ProviderId = z.enum(["t3-code", "claude-code", "codex", "copilot-cli"]);
export type ProviderId = z.infer<typeof ProviderId>;

export interface ProviderInfo {
  label: string;
  /** What it is, for the Add provider dialog. */
  blurb: string;
  /** The CLI's name on PATH; null for T3 Code, which the board reaches over HTTP. */
  cli: string | null;
  /** The harness its sessions are, for the CLI providers. */
  harness: AgentHarness | null;
  /** The hand-off menu entry it offers, if any. */
  handoff: HandoffTarget | null;
  /** The command that registers the board's MCP server, or null when it is set up another way. */
  mcpCommand: ((name: string, url: string) => string) | null;
  /** Whether the board can tell its MCP registration from its config. */
  detectsMcp: boolean;
  /** Whether the board can install its skill (skillSync's harness name), or null. */
  skill: "claude" | "copilot" | "codex" | null;
  /** Whether it lists its models for the model pickers. */
  scansModels: boolean;
}

/** Every provider, in the order the list and the Add dialog show them. */
export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  "t3-code": {
    label: "T3 Code",
    blurb: "Thread links, live thread status, and starting tasks in T3 threads.",
    cli: null,
    harness: null,
    handoff: "t3-code",
    mcpCommand: null,
    detectsMcp: false,
    skill: null,
    scansModels: false,
  },
  "claude-code": {
    label: "Claude Code",
    blurb: "New sessions from a task, the board reviewer, issue import and headless Autopilot runs.",
    cli: "claude",
    harness: "claude-code",
    handoff: "claude-code",
    mcpCommand: (name, url) => `claude mcp add --scope user --transport http ${name} ${url}`,
    detectsMcp: true,
    skill: "claude",
    scansModels: true,
  },
  codex: {
    label: "Codex",
    blurb: "New Codex sessions from a task, headless Autopilot runs on a Codex model, and reopening Codex sessions.",
    cli: "codex",
    harness: "codex",
    handoff: "codex",
    mcpCommand: (name, url) => `codex mcp add ${name} --url ${url}`,
    detectsMcp: true,
    skill: "codex",
    scansModels: true,
  },
  "copilot-cli": {
    label: "GitHub Copilot",
    blurb: "New Copilot CLI sessions from a task, and the MCP server in VS Code.",
    cli: "copilot",
    harness: "copilot-cli",
    handoff: "copilot-cli",
    mcpCommand: (name, url) => `copilot mcp add --transport http ${name} ${url}`,
    detectsMcp: true,
    skill: "copilot",
    scansModels: true,
  },
};

/** The provider a harness's sessions belong to: each CLI harness is its own provider. */
export const providerOfHarness = (harness: AgentHarness): ProviderId => harness;

/** A provider the user added: whether it is on, and the CLI path the board runs (null looks its name up on PATH). */
export const ProviderSetting = z.object({
  id: ProviderId,
  enabled: z.boolean(),
  cliPath: z.string().trim().nullable().optional(),
});
export type ProviderSetting = z.infer<typeof ProviderSetting>;

/** The added providers, in the user's order. One entry per provider. */
export const ProviderSettings = z
  .array(ProviderSetting)
  .refine((list) => new Set(list.map((p) => p.id)).size === list.length, "A provider is listed twice");
export type ProviderSettings = z.infer<typeof ProviderSettings>;

type WithProviders = { providers: readonly ProviderSetting[] };

/** The provider's entry, when it was added. */
export const providerSetting = (settings: WithProviders, id: ProviderId): ProviderSetting | undefined =>
  settings.providers.find((p) => p.id === id);

/** Added and switched on: what the menus, dialogs and pickers offer. */
export const providerActive = (settings: WithProviders | undefined, id: ProviderId): boolean =>
  settings?.providers.some((p) => p.id === id && p.enabled) ?? false;

/** The CLI path set for a harness in Settings → Agents → Providers, or null to look its name up on PATH. */
export const harnessCliSetting = (settings: WithProviders, harness: AgentHarness): string | null =>
  providerSetting(settings, providerOfHarness(harness))?.cliPath?.trim() || null;

export const ProviderCliStatus = z.object({
  /** The executable was found and `--version` ran. */
  found: z.boolean(),
  path: z.string().nullable(),
  version: z.string().nullable(),
  /** Why it isn't usable, when it isn't. */
  error: z.string().nullable(),
});
export type ProviderCliStatus = z.infer<typeof ProviderCliStatus>;

export const ProviderMcpStatus = z.object({
  /** Some entry of the harness's MCP config points at the board's MCP URL, whatever it is named. */
  registered: z.boolean(),
  /** Whether the harness reports that entry as connected; null when it can't tell. */
  connected: z.boolean().nullable(),
  /** Where the entry is configured ("user", "local", "project"), when known. */
  scope: z.string().nullable(),
  /** The entry's name in the harness's config. */
  name: z.string().nullable(),
  /** What was found or why the check couldn't tell, in words. Never a URL or token. */
  detail: z.string().nullable(),
});
export type ProviderMcpStatus = z.infer<typeof ProviderMcpStatus>;

/** What the models scan found, for a provider that lists its models. */
export const ProviderModelsStatus = z.object({
  count: z.number().int().min(0),
  scannedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type ProviderModelsStatus = z.infer<typeof ProviderModelsStatus>;

/** One provider as detected here, added or not. A part that doesn't apply to the provider is null. */
export const ProviderStatus = z.object({
  id: ProviderId,
  cli: ProviderCliStatus.nullable(),
  mcp: ProviderMcpStatus.nullable(),
  /** T3 Code's own status, and whether a token is saved. */
  t3: z
    .object({
      detected: z.boolean(),
      origin: z.string().nullable(),
      label: z.string().nullable(),
      liveStatus: z.enum(["off", "ok", "error"]),
      error: z.string().nullable(),
      tokenSet: z.boolean(),
    })
    .nullable(),
  /** Only scanned for an added provider; null otherwise. */
  models: ProviderModelsStatus.nullable(),
});
export type ProviderStatus = z.infer<typeof ProviderStatus>;

/** `GET /api/providers`: every provider, plus the MCP URL registrations were matched against. */
export const ProvidersStatus = z.object({
  mcpUrl: z.string(),
  checkedAt: z.string(),
  providers: z.array(ProviderStatus),
});
export type ProvidersStatus = z.infer<typeof ProvidersStatus>;

/** T3 Code's part of a provider status, from the integration's status and the settings. */
export const t3ProviderStatus = (
  status: T3IntegrationStatus,
  tokenSet: boolean,
): NonNullable<ProviderStatus["t3"]> => ({
  detected: status.detected,
  origin: status.origin,
  label: status.label,
  liveStatus: status.liveStatus,
  error: status.error,
  tokenSet,
});
