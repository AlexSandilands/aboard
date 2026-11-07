import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_HARNESSES,
  AgentHarness,
  type AgentModelsStatus,
  type AppSettings,
  harnessCliSetting,
  PROVIDERS,
  ProviderId,
  type ProviderCliStatus,
  type ProviderMcpStatus,
  type ProviderSetting,
  type ProviderStatus,
  type ProvidersStatus,
  providerActive,
  type T3IntegrationStatus,
  t3ProviderStatus,
} from "@repo/contracts";
import type { Services } from "../services/types.ts";
import { claudeOutput, executableVersion, resolveExecutable } from "./claudeCli.ts";
import { messageOf } from "./util.ts";
import type { TerminalHost } from "./terminal.ts";

// The one place the board detects its providers, for Settings → Agents → Providers and everything that offers one: whether
// each CLI runs here, whether it has the board's MCP server registered, T3 Code's status, and what the models scan
// found. The MCP entry is found by its URL, not its name: it is the user's to name. Config files are read for server
// names and URLs only; headers and tokens in them are never looked at. See docs/features/agent-sessions.md.

/** How long an answer is reused. `claude mcp list` health-checks every server the user has, which can take a while. */
const CACHE_MS = 60_000;
/** `claude mcp list` connects to each server; one that hangs shouldn't hold the settings page. */
const MCP_LIST_TIMEOUT_MS = 30_000;
const MCP_GET_TIMEOUT_MS = 15_000;

/** The default port of a URL's scheme, for comparing `http://host` with `http://host:80`. */
const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
};

/**
 * Whether two MCP URLs name the same endpoint: `localhost`, `127.0.0.1` and `[::1]` are one host, the port counts, a
 * trailing slash doesn't, and neither do a query or fragment (which may carry a token). Anything that isn't a URL
 * matches nothing.
 */
export function sameMcpUrl(a: string, b: string): boolean {
  const key = (value: string): string | null => {
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      return null;
    }
    const host = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase())
      ? "loopback"
      : url.hostname.toLowerCase();
    return `${url.protocol}//${host}:${url.port || DEFAULT_PORTS[url.protocol] || ""}${url.pathname.replace(/\/+$/, "")}`;
  };
  const left = key(a);
  return left !== null && left === key(b);
}

export interface McpEntry {
  name: string;
  /** The URL for a remote server; null for one started by a command. */
  url: string | null;
}

export interface ClaudeMcpListEntry extends McpEntry {
  /** What `claude mcp list` says after the target: "✓ Connected", "✗ Failed to connect", "! Needs authentication". */
  status: string;
  connected: boolean;
}

/**
 * The servers `claude mcp list` prints. Lines read `name: <url or command> (HTTP) - ✓ Connected`; anything that
 * isn't a line like that (the header, a blank line) is skipped.
 */
export function parseClaudeMcpList(stdout: string): ClaudeMcpListEntry[] {
  const entries: ClaudeMcpListEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const split = line.indexOf(": ");
    const dash = line.lastIndexOf(" - ");
    if (split <= 0 || dash <= split) continue;
    const target = line
      .slice(split + 2, dash)
      .replace(/\s*\((?:HTTP|SSE)\)\s*$/i, "")
      .trim();
    const status = line.slice(dash + 3).trim();
    entries.push({
      name: line.slice(0, split).trim(),
      url: /^https?:\/\//i.test(target) ? target : null,
      status: status.replace(/^[^\w]+/, ""),
      connected: /\bConnected$/.test(status),
    });
  }
  return entries;
}

/** The scope `claude mcp get <name>` reports: "user", "local" or "project". Null when it isn't stated. */
export function parseClaudeMcpScope(stdout: string): string | null {
  const word = /^\s*Scope:\s*(\w+)/im.exec(stdout)?.[1]?.toLowerCase();
  return word === "user" || word === "local" || word === "project" ? word : null;
}

/**
 * The servers a JSON MCP config names (`mcpServers`, or `servers` in VS Code's shape) with their URLs. Only names and
 * `url` strings are read; headers, env and the rest, where tokens live, are not touched.
 */
export function mcpEntriesOf(json: unknown): McpEntry[] {
  if (!json || typeof json !== "object") return [];
  const record = json as Record<string, unknown>;
  const servers = record.mcpServers ?? record.servers;
  if (!servers || typeof servers !== "object") return [];
  return Object.entries(servers as Record<string, unknown>).map(([name, value]) => {
    const url = value && typeof value === "object" ? (value as { url?: unknown }).url : null;
    return { name, url: typeof url === "string" ? url : null };
  });
}

/**
 * Entries `claude mcp add` stored for one project (local scope): `projects[<folder>].mcpServers` of ~/.claude.json.
 * `claude mcp list` only shows them from that folder, which the board can't know.
 */
export function projectMcpEntriesOf(json: unknown): McpEntry[] {
  const projects = json && typeof json === "object" ? (json as { projects?: unknown }).projects : null;
  if (!projects || typeof projects !== "object") return [];
  return Object.values(projects as Record<string, unknown>).flatMap(mcpEntriesOf);
}

/**
 * The servers Codex's `config.toml` names, from its `[mcp_servers.<name>]` tables and the `url` in each. A line-based
 * read of the few shapes Codex writes, not a TOML parser: only table headers and `url` lines are looked at, so
 * `http_headers` and `env`, where tokens live, are never read.
 */
export function codexMcpEntries(toml: string): McpEntry[] {
  const entries: McpEntry[] = [];
  let current: McpEntry | null = null;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      // `[mcp_servers.board]` or `[mcp_servers."my board"]`; a sub-table such as `[mcp_servers.board.env]` isn't one.
      const header = /^\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*\]$/.exec(line);
      current = header ? { name: (header[1] ?? header[2])!, url: null } : null;
      if (current) entries.push(current);
      continue;
    }
    const url = current && /^url\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
    if (current && url) current.url = url[1] ?? url[2] ?? null;
  }
  return entries;
}

const entriesInFile = (read: (path: string) => string | null, path: string): McpEntry[] => {
  const text = read(path);
  if (text === null) return [];
  try {
    return mcpEntriesOf(JSON.parse(text));
  } catch {
    return [];
  }
};

const matching = <T extends McpEntry>(entries: readonly T[], boardUrl: string): T | undefined =>
  entries.find((entry) => entry.url !== null && sameMcpUrl(entry.url, boardUrl));

/** ~/.claude.json's entry for the board: the user-scope ones first, then any project's. */
const claudeConfigMatch = (
  read: (path: string) => string | null,
  home: string,
  boardUrl: string,
): { entry: McpEntry; scope: "user" | "local" } | null => {
  const text = read(join(home, ".claude.json"));
  let json: unknown;
  try {
    json = text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
  const user = matching(mcpEntriesOf(json), boardUrl);
  if (user) return { entry: user, scope: "user" };
  const local = matching(projectMcpEntriesOf(json), boardUrl);
  return local ? { entry: local, scope: "local" } : null;
};

const NOT_REGISTERED = (detail: string): ProviderMcpStatus => ({
  registered: false,
  connected: null,
  scope: null,
  name: null,
  detail,
});

/** What the checks run: replaced in tests so no CLI is started and no file is read. */
export interface ProviderProbes {
  /** The CLI's executable on this machine, or null. */
  resolve: (command: string) => string | null;
  version: (exe: string, label: string) => Promise<string>;
  /** `claude mcp <args>`'s stdout; throws when it fails or times out. */
  claudeMcp: (exe: string, args: string[], timeoutMs: number) => Promise<string>;
  readFile: (path: string) => string | null;
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** Every check, or only the CLIs (resolved, with their version) and T3 Code: what the board's menus need, quickly. */
export type ProviderParts = "all" | "cli";

export interface ProvidersService {
  /**
   * Every provider as detected here; the checks are reused for a minute unless `refresh` is set. `parts: "cli"` leaves
   * out the MCP checks and model scans, which can take many seconds.
   */
  status(refresh?: boolean, parts?: ProviderParts): Promise<ProvidersStatus>;
  /**
   * On an install upgraded to opt-in providers, adds those detection finds in use (the MCP server registered, or a
   * hand-off entry the menus showed), once. Resolves to the ids it added.
   */
  seedFromDetection(): Promise<ProviderId[]>;
}

export function createProviders(deps: {
  services: () => Pick<Services, "settings">;
  /** The board's MCP endpoint as agents reach it. */
  mcpUrl: () => string;
  host: () => TerminalHost;
  userHome: string;
  t3Status: () => T3IntegrationStatus;
  /** A harness's models scan (agentModels.ts), which keeps its own longer cache. */
  models?: (harness: AgentHarness, refresh: boolean) => Promise<AgentModelsStatus>;
  probes?: Partial<ProviderProbes>;
  now?: () => number;
}): ProvidersService {
  const now = deps.now ?? Date.now;
  const probes: ProviderProbes = {
    resolve: (command) => {
      const h = deps.host();
      return resolveExecutable(command, h.env, h.platform);
    },
    version: executableVersion,
    claudeMcp: (exe, args, timeoutMs) => claudeOutput(exe, args, { timeoutMs, cwd: deps.userHome }),
    readFile: readText,
    ...deps.probes,
  };

  const cliOf = async (harness: AgentHarness, configured: string | null): Promise<ProviderCliStatus> => {
    const command = configured ?? AGENT_HARNESSES[harness].cli;
    const path = probes.resolve(command);
    const base = { found: false, path, version: null, error: null };
    if (!path) {
      return {
        ...base,
        error: configured ? `Not found at ${configured}` : `${command} isn't on PATH`,
      };
    }
    try {
      return { ...base, found: true, version: await probes.version(path, AGENT_HARNESSES[harness].label) };
    } catch (error) {
      return { ...base, error: messageOf(error).slice(0, 200) };
    }
  };

  const claudeMcp = async (exe: string | null, boardUrl: string): Promise<ProviderMcpStatus> => {
    // The CLI knows every scope and whether the server answers. When it can't be asked (missing, or too slow with a
    // server that hangs), the user-scope config file still says whether the entry exists.
    let askError: string | null = exe ? null : "Claude Code isn't available to ask";
    if (exe) {
      try {
        const listed = parseClaudeMcpList(await probes.claudeMcp(exe, ["mcp", "list"], MCP_LIST_TIMEOUT_MS));
        const found = matching(listed, boardUrl);
        if (!found) {
          // Added with `claude mcp add` in a project folder (local scope), it is only listed from there.
          const stored = claudeConfigMatch(probes.readFile, deps.userHome, boardUrl);
          return stored
            ? {
                registered: true,
                connected: null,
                scope: stored.scope,
                name: stored.entry.name,
                detail: "Registered for one project only: add it with --scope user to use it everywhere",
              }
            : NOT_REGISTERED(`No Claude Code MCP server points at the board (${listed.length} registered)`);
        }
        const scope = await probes
          .claudeMcp(exe, ["mcp", "get", found.name], MCP_GET_TIMEOUT_MS)
          .then(parseClaudeMcpScope)
          .catch(() => null);
        return {
          registered: true,
          connected: found.connected,
          scope,
          name: found.name,
          detail: found.status,
        };
      } catch (error) {
        askError = `claude mcp list failed: ${messageOf(error).slice(0, 120)}`;
      }
    }
    const stored = claudeConfigMatch(probes.readFile, deps.userHome, boardUrl);
    return stored
      ? {
          registered: true,
          connected: null,
          scope: stored.scope,
          name: stored.entry.name,
          detail: `${askError}; found in the user config`,
        }
      : NOT_REGISTERED(`${askError}; not in the user config either`);
  };

  const copilotMcp = (boardUrl: string): ProviderMcpStatus => {
    const home = deps.host().env.COPILOT_HOME ?? join(deps.userHome, ".copilot");
    const path = join(home, "mcp-config.json");
    if (probes.readFile(path) === null) return NOT_REGISTERED("No MCP config for Copilot CLI yet");
    const found = matching(entriesInFile(probes.readFile, path), boardUrl);
    return found
      ? {
          registered: true,
          connected: null,
          scope: "user",
          name: found.name,
          detail: "In Copilot CLI's MCP config",
        }
      : NOT_REGISTERED("No MCP server in Copilot CLI's config points at the board");
  };

  const codexMcp = (boardUrl: string): ProviderMcpStatus => {
    const home = deps.host().env.CODEX_HOME ?? join(deps.userHome, ".codex");
    const text = probes.readFile(join(home, "config.toml"));
    if (text === null) return NOT_REGISTERED("No Codex config yet");
    const found = matching(codexMcpEntries(text), boardUrl);
    return found
      ? { registered: true, connected: null, scope: "user", name: found.name, detail: "In Codex's config.toml" }
      : NOT_REGISTERED("No MCP server in Codex's config.toml points at the board");
  };

  const modelsOf = async (
    settings: AppSettings,
    harness: AgentHarness,
    refresh: boolean,
  ): Promise<ProviderStatus["models"]> => {
    // Scanning starts the CLI (Claude Code runs its hooks first), so only for providers the user added.
    if (!deps.models || !PROVIDERS[harness].scansModels || !providerActive(settings, harness)) return null;
    try {
      const scan = await deps.models(harness, refresh);
      return { count: scan.models.length, scannedAt: scan.scannedAt, error: scan.error };
    } catch (error) {
      return { count: 0, scannedAt: null, error: messageOf(error).slice(0, 200) };
    }
  };

  /**
   * One answer kept for a minute under a key; a refresh skips it, and joins a check still running rather than starting
   * another (`claude mcp list` health-checks every server the user has). A check that threw isn't kept.
   */
  const cacheOf = <T>() => {
    let cached: { key: string; at: number; result: Promise<T>; pending: boolean } | null = null;
    return (key: string, refresh: boolean, run: () => Promise<T>): Promise<T> => {
      if (cached?.key === key && (cached.pending || (!refresh && now() - cached.at < CACHE_MS))) return cached.result;
      const result = run();
      const entry = { key, at: now(), result, pending: true };
      cached = entry;
      const settle = () => {
        entry.pending = false;
      };
      result.then(settle, settle);
      result.catch(() => {
        if (cached?.result === result) cached = null;
      });
      return result;
    };
  };
  const cliCache = cacheOf<Record<AgentHarness, ProviderCliStatus>>();
  const fullCache = cacheOf<ProviderStatus[]>();

  /** Each CLI resolved and its `--version`: quick, so the menus wait on nothing else. Keyed by the configured paths. */
  const clis = (settings: AppSettings, refresh: boolean) => {
    const paths = AgentHarness.options.map((harness) => harnessCliSetting(settings, harness));
    return cliCache(JSON.stringify(paths), refresh, async () => {
      const found = await Promise.all(AgentHarness.options.map((harness, i) => cliOf(harness, paths[i] ?? null)));
      return Object.fromEntries(AgentHarness.options.map((harness, i) => [harness, found[i]!])) as Record<
        AgentHarness,
        ProviderCliStatus
      >;
    });
  };

  /** Everything but T3 Code, whose status is live and cheap, so it is never cached. */
  const compute = async (settings: AppSettings, boardUrl: string, refresh: boolean): Promise<ProviderStatus[]> => {
    const [cli, claudeModels, copilotModels] = await Promise.all([
      clis(settings, refresh),
      modelsOf(settings, "claude-code", refresh),
      modelsOf(settings, "copilot-cli", refresh),
    ]);
    const claudeCli = cli["claude-code"];
    return [
      {
        id: "claude-code",
        cli: claudeCli,
        mcp: await claudeMcp(claudeCli.found ? claudeCli.path : null, boardUrl),
        t3: null,
        models: claudeModels,
      },
      { id: "codex", cli: cli.codex, mcp: codexMcp(boardUrl), t3: null, models: null },
      { id: "copilot-cli", cli: cli["copilot-cli"], mcp: copilotMcp(boardUrl), t3: null, models: copilotModels },
    ];
  };

  const detect = (refresh: boolean, parts: ProviderParts): Promise<ProviderStatus[]> => {
    const settings = deps.services().settings.get();
    if (parts === "cli") {
      return clis(settings, refresh).then((cli) =>
        AgentHarness.options.map((harness) => ({ id: harness, cli: cli[harness], mcp: null, t3: null, models: null })),
      );
    }
    const boardUrl = deps.mcpUrl();
    // A new CLI path, or a provider added or switched (which decides whether its models are scanned), asks again.
    const key = JSON.stringify([settings.providers.filter((p) => p.enabled), boardUrl]);
    return fullCache(key, refresh, () => compute(settings, boardUrl, refresh));
  };

  const status = async (refresh = false, parts: ProviderParts = "all"): Promise<ProvidersStatus> => {
    const detected = await detect(refresh, parts);
    const t3: ProviderStatus = {
      id: "t3-code",
      cli: null,
      mcp: null,
      t3: t3ProviderStatus(deps.t3Status(), deps.services().settings.get().t3TokenSet),
      models: null,
    };
    const byId = new Map([t3, ...detected].map((p) => [p.id, p]));
    return {
      mcpUrl: deps.mcpUrl(),
      checkedAt: new Date(now()).toISOString(),
      providers: ProviderId.options.map((id) => byId.get(id)!),
    };
  };

  return {
    status,
    async seedFromDetection() {
      if (!deps.services().settings.providersSeedPending()) return [];
      const found = await status(true);
      const settings = deps.services().settings.get();
      const added = found.providers.flatMap((provider) => {
        if (settings.providers.some((p) => p.id === provider.id)) return [];
        const handoff = PROVIDERS[provider.id].handoff;
        // What the hand-off menus offered before providers were opt-in: the entry on, and the CLI or T3 there. They
        // had no Codex entry then.
        const offered =
          handoff !== null &&
          handoff !== "codex" &&
          settings.handoffMenus[handoff] &&
          (provider.cli?.found || (provider.t3?.detected && provider.t3.tokenSet));
        return provider.mcp?.registered || offered ? [provider.id] : [];
      });
      if (added.length > 0) {
        const next: ProviderSetting[] = [
          ...settings.providers,
          ...added.map((id) => ({ id, enabled: true, cliPath: null })),
        ];
        deps.services().settings.update({ providers: next });
      }
      deps.services().settings.clearProvidersSeed();
      return added;
    },
  };
}
