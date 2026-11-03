import type { AgentModelsStatus, ProviderSetting, ProvidersStatus, T3IntegrationStatus } from "@repo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "../test/harness.ts";
import {
  createProviders,
  codexMcpEntries,
  mcpEntriesOf,
  parseClaudeMcpList,
  parseClaudeMcpScope,
  sameMcpUrl,
  type ProviderProbes,
} from "./providers.ts";
import type { TerminalHost } from "./terminal.ts";

const LIST = [
  "Checking MCP server health...",
  "",
  "atlassian: https://mcp.atlassian.com/v1/sse (SSE) - ! Needs authentication",
  "tasks: http://localhost:4317/mcp (HTTP) - ✓ Connected",
  "filesystem: npx -y @modelcontextprotocol/server-filesystem /tmp - ✓ Connected",
  "other: http://127.0.0.1:9999/mcp (HTTP) - ✗ Failed to connect",
].join("\n");

describe("sameMcpUrl", () => {
  const board = "http://127.0.0.1:4317/mcp";

  it("treats localhost and 127.0.0.1 as one host", () => {
    expect(sameMcpUrl(board, "http://localhost:4317/mcp")).toBe(true);
    expect(sameMcpUrl(board, "http://[::1]:4317/mcp")).toBe(true);
  });

  it("ignores a trailing slash, a query and case in the host", () => {
    expect(sameMcpUrl(board, "http://127.0.0.1:4317/mcp/")).toBe(true);
    expect(sameMcpUrl(board, "http://127.0.0.1:4317/mcp?token=x")).toBe(true);
    expect(sameMcpUrl(board, "http://LocalHost:4317/mcp")).toBe(true);
  });

  it("tells another port, path, host or scheme apart", () => {
    expect(sameMcpUrl(board, "http://127.0.0.1:4318/mcp")).toBe(false);
    expect(sameMcpUrl(board, "http://127.0.0.1:4317/other")).toBe(false);
    expect(sameMcpUrl(board, "http://example.com:4317/mcp")).toBe(false);
    expect(sameMcpUrl(board, "https://127.0.0.1:4317/mcp")).toBe(false);
  });

  it("compares default ports", () => {
    expect(sameMcpUrl("http://localhost/mcp", "http://127.0.0.1:80/mcp")).toBe(true);
  });

  it("matches nothing that isn't a URL", () => {
    expect(sameMcpUrl(board, "npx some-server")).toBe(false);
    expect(sameMcpUrl("nope", "nope")).toBe(false);
  });
});

describe("parseClaudeMcpList", () => {
  it("reads names, URLs and states, and skips the rest", () => {
    expect(parseClaudeMcpList(LIST)).toEqual([
      {
        name: "atlassian",
        url: "https://mcp.atlassian.com/v1/sse",
        status: "Needs authentication",
        connected: false,
      },
      {
        name: "tasks",
        url: "http://localhost:4317/mcp",
        status: "Connected",
        connected: true,
      },
      { name: "filesystem", url: null, status: "Connected", connected: true },
      {
        name: "other",
        url: "http://127.0.0.1:9999/mcp",
        status: "Failed to connect",
        connected: false,
      },
    ]);
  });
});

describe("parseClaudeMcpScope", () => {
  it("reads the first word of the scope", () => {
    expect(parseClaudeMcpScope("tasks:\n  Scope: User config (available in all your projects)\n")).toBe("user");
    expect(parseClaudeMcpScope("tasks:\n  Scope: Local config (private to you in this project)\n")).toBe("local");
    expect(parseClaudeMcpScope("tasks:\n  Scope: Project config (shared via .mcp.json)\n")).toBe("project");
    expect(parseClaudeMcpScope("nothing here")).toBeNull();
  });
});

describe("mcpEntriesOf", () => {
  it("reads names and URLs only", () => {
    const entries = mcpEntriesOf({
      mcpServers: {
        tasks: {
          type: "http",
          url: "http://127.0.0.1:4317/mcp",
          headers: { Authorization: "Bearer secret" },
        },
        local: { command: "npx", args: ["x"], env: { TOKEN: "secret" } },
      },
    });
    expect(entries).toEqual([
      { name: "tasks", url: "http://127.0.0.1:4317/mcp" },
      { name: "local", url: null },
    ]);
    expect(JSON.stringify(entries)).not.toContain("secret");
  });

  it("reads VS Code's servers key and ignores other shapes", () => {
    expect(mcpEntriesOf({ servers: { a: { url: "http://x/mcp" } } })).toEqual([{ name: "a", url: "http://x/mcp" }]);
    expect(mcpEntriesOf(null)).toEqual([]);
    expect(mcpEntriesOf({ mcpServers: "nope" })).toEqual([]);
  });
});

const BOARD = "http://127.0.0.1:4317/mcp";
const host = (env: Record<string, string> = {}): TerminalHost => ({
  platform: "linux",
  env,
  readFile: () => null,
  which: () => null,
});

const T3_OFF: T3IntegrationStatus = {
  detected: false,
  origin: null,
  environmentId: null,
  label: null,
  liveStatus: "off",
  error: null,
};

function service(
  probes: Partial<ProviderProbes>,
  opts: {
    now?: () => number;
    env?: Record<string, string>;
    t3?: T3IntegrationStatus;
    models?: (harness: string, refresh: boolean) => Promise<AgentModelsStatus>;
  } = {},
) {
  const settings = {
    providers: [] as ProviderSetting[],
    t3TokenSet: false,
    handoffMenus: { "t3-code": true, "claude-code": true, "copilot-cli": true },
  };
  let seedPending = false;
  const update = vi.fn<(input: { providers?: ProviderSetting[] }) => void>((input) => {
    if (input.providers) settings.providers = input.providers;
  });
  const svc = createProviders({
    services: () =>
      ({
        settings: {
          get: () => settings,
          update,
          providersSeedPending: () => seedPending,
          clearProvidersSeed: () => {
            seedPending = false;
          },
        },
      }) as never,
    mcpUrl: () => BOARD,
    host: () => host(opts.env),
    userHome: "/home/u",
    t3Status: () => opts.t3 ?? T3_OFF,
    ...(opts.models ? { models: opts.models } : {}),
    probes: {
      resolve: (command) => `/bin/${command}`,
      version: () => Promise.resolve("2.0.0"),
      claudeMcp: (_exe, args) => Promise.resolve(args[1] === "get" ? "tasks:\n  Scope: User config\n" : LIST),
      readFile: () => null,
      ...probes,
    },
    ...(opts.now ? { now: opts.now } : {}),
  });
  return {
    svc,
    settings,
    update,
    pendSeed: () => {
      seedPending = true;
    },
    seedPending: () => seedPending,
  };
}

const providerOf = (r: ProvidersStatus, id: string) => r.providers.find((p) => p.id === id)!;
const claudeOf = (r: ProvidersStatus) => providerOf(r, "claude-code");
const copilotOf = (r: ProvidersStatus) => providerOf(r, "copilot-cli");

describe("providers: Claude Code", () => {
  it("finds the board's server by its URL under any name", async () => {
    const { svc } = service({});
    const claude = claudeOf(await svc.status());
    expect(claude.cli).toEqual({
      found: true,
      path: "/bin/claude",
      version: "2.0.0",
      error: null,
    });
    expect(claude.mcp).toEqual({
      registered: true,
      connected: true,
      scope: "user",
      name: "tasks",
      detail: "Connected",
    });
  });

  it("reports a registered server that doesn't connect", async () => {
    const { svc } = service({
      claudeMcp: () => Promise.resolve("tasks: http://127.0.0.1:4317/mcp (HTTP) - ✗ Failed to connect"),
    });
    expect(claudeOf(await svc.status()).mcp).toMatchObject({
      registered: true,
      connected: false,
    });
  });

  it("is not registered when no server has the board's URL (another port)", async () => {
    const { svc } = service({
      claudeMcp: () => Promise.resolve("tasks: http://127.0.0.1:4318/mcp (HTTP) - ✓ Connected"),
    });
    expect(claudeOf(await svc.status()).mcp).toMatchObject({
      registered: false,
      connected: null,
    });
  });

  it("says why the CLI isn't usable", async () => {
    const { svc, settings } = service({ resolve: () => null });
    expect(claudeOf(await svc.status()).cli).toMatchObject({
      found: false,
      path: null,
      error: "claude isn't on PATH",
    });
    settings.providers = [{ id: "claude-code", enabled: true, cliPath: "/opt/claude" }];
    expect(claudeOf(await svc.status(true)).cli?.error).toBe("Not found at /opt/claude");

    const failing = service({
      version: () => Promise.reject(new Error("boom")),
    });
    expect(claudeOf(await failing.svc.status()).cli).toMatchObject({
      found: false,
      path: "/bin/claude",
      error: "boom",
    });
  });

  it("falls back to the user config when the CLI can't be asked", async () => {
    const json = JSON.stringify({
      mcpServers: {
        aboard: {
          type: "http",
          url: "http://localhost:4317/mcp/",
          headers: { Authorization: "Bearer x" },
        },
      },
    });
    const files: string[] = [];
    const { svc } = service({
      claudeMcp: () => Promise.reject(new Error("timed out")),
      readFile: (path) => {
        files.push(path);
        return path.endsWith(".claude.json") ? json : null;
      },
    });
    const claude = claudeOf(await svc.status());
    expect(claude.mcp).toMatchObject({
      registered: true,
      connected: null,
      scope: "user",
      name: "aboard",
    });
    expect(claude.mcp?.detail).toContain("timed out");
    expect(claude.mcp?.detail).not.toContain("Bearer");
    expect(files.some((f) => f.replace(/\\/g, "/") === "/home/u/.claude.json")).toBe(true);
  });
});

describe("providers: Claude Code local scope", () => {
  const stored = JSON.stringify({
    mcpServers: {},
    projects: {
      "/work/app": {
        mcpServers: { aboard: { type: "http", url: "http://localhost:4317/mcp", headers: { A: "secret" } } },
      },
    },
  });

  it("finds a server added in one project, which `claude mcp list` only shows from there", async () => {
    const { svc } = service({
      claudeMcp: () => Promise.resolve("other: http://127.0.0.1:9999/mcp (HTTP) - ✓ Connected"),
      readFile: (path) => (path.endsWith(".claude.json") ? stored : null),
    });
    const mcp = claudeOf(await svc.status()).mcp;
    expect(mcp).toMatchObject({ registered: true, connected: null, scope: "local", name: "aboard" });
    expect(mcp?.detail).toContain("--scope user");
    expect(JSON.stringify(mcp)).not.toContain("secret");
  });
});

describe("providers: Copilot CLI", () => {
  const config = (url: string) =>
    JSON.stringify({
      mcpServers: { aboard: { type: "http", url, tools: ["*"] } },
    });

  it("finds the board's entry in mcp-config.json", async () => {
    const { svc } = service({
      readFile: (p) => (p.endsWith("mcp-config.json") ? config("http://localhost:4317/mcp") : null),
    });
    const copilot = copilotOf(await svc.status());
    expect(copilot.cli).toMatchObject({ found: true, path: "/bin/copilot" });
    expect(copilot.mcp).toMatchObject({
      registered: true,
      connected: null,
      name: "aboard",
      scope: "user",
    });
  });

  it("reads the config under COPILOT_HOME", async () => {
    const read = vi.fn<(p: string) => string | null>((p) =>
      p.replace(/\\/g, "/") === "/c/mcp-config.json" ? config(BOARD) : null,
    );
    const { svc } = service({ readFile: read }, { env: { COPILOT_HOME: "/c" } });
    expect(copilotOf(await svc.status()).mcp?.registered).toBe(true);
  });

  it("is not registered without a config or without the board's entry", async () => {
    expect(copilotOf(await service({}).svc.status()).mcp).toMatchObject({
      registered: false,
    });
    const other = service({ readFile: () => config("http://127.0.0.1:1/mcp") });
    expect(copilotOf(await other.svc.status()).mcp).toMatchObject({
      registered: false,
    });
  });
});

describe("providers: Codex", () => {
  const TOML = [
    'model = "gpt-5.5"',
    "[mcp_servers.other]",
    'command = "npx"',
    '[mcp_servers."my board"]',
    'url = "http://localhost:4317/mcp"',
    '[mcp_servers."my board".http_headers]',
    'Authorization = "Bearer x"',
    'url = "http://elsewhere/mcp"',
  ].join("\n");

  it("reads server names and their urls from config.toml, and nothing in sub-tables", () => {
    expect(codexMcpEntries(TOML)).toEqual([
      { name: "other", url: null },
      { name: "my board", url: "http://localhost:4317/mcp" },
    ]);
  });

  it("finds the board in config.toml under CODEX_HOME", async () => {
    const read = (p: string) => (p.replace(/\\/g, "/") === "/x/config.toml" ? TOML : null);
    const { svc } = service({ readFile: read }, { env: { CODEX_HOME: "/x" } });
    const codex = providerOf(await svc.status(), "codex");
    expect(codex.cli).toMatchObject({ found: true, path: "/bin/codex" });
    expect(codex.mcp).toMatchObject({ registered: true, name: "my board", scope: "user" });
    const none = providerOf(await service({}).svc.status(), "codex");
    expect(none.mcp).toMatchObject({ registered: false, detail: "No Codex config yet" });
  });
});

describe("providers: refresh", () => {
  it("joins a check that is still running instead of starting another", async () => {
    let release: (() => void) | undefined;
    const claudeMcp = vi.fn<(exe: string, args: string[]) => Promise<string>>((_exe, args) =>
      args[1] === "get"
        ? Promise.resolve("tasks:\n  Scope: User config\n")
        : new Promise((resolve) => (release = () => resolve(LIST))),
    );
    const { svc } = service({ claudeMcp });
    const first = svc.status(true);
    const second = svc.status(true);
    await vi.waitFor(() => expect(release).toBeDefined());
    release?.();
    await Promise.all([first, second]);
    // One `mcp list` (and its `mcp get`) for both calls, then a refresh after it settled runs again.
    const lists = () => claudeMcp.mock.calls.filter(([, args]) => args[1] === "list").length;
    expect(lists()).toBe(1);
    claudeMcp.mockImplementation((_exe, args) => Promise.resolve(args[1] === "get" ? "" : LIST));
    await svc.status(true);
    expect(lists()).toBe(2);
  });
});

describe("providers: cache", () => {
  it("reuses an answer for a minute, until refreshed or a CLI path changes", async () => {
    let time = 0;
    const version = vi.fn<(exe: string) => Promise<string>>(() => Promise.resolve("2.0.0"));
    const { svc, settings } = service({ version }, { now: () => time });
    await svc.status();
    await svc.status();
    expect(version).toHaveBeenCalledTimes(3); // claude, codex and copilot, once
    time = 61_000;
    await svc.status();
    expect(version).toHaveBeenCalledTimes(6);
    await svc.status(true);
    expect(version).toHaveBeenCalledTimes(9);
    settings.providers = [{ id: "copilot-cli", enabled: true, cliPath: "/opt/copilot" }];
    await svc.status();
    expect(version).toHaveBeenCalledTimes(12);
  });
});

describe("providers: T3 Code and models", () => {
  it("lists every provider in order, with T3 Code's live status and whether a token is saved", async () => {
    const { svc, settings } = service(
      {},
      { t3: { ...T3_OFF, detected: true, origin: "http://127.0.0.1:3773", liveStatus: "ok" } },
    );
    settings.t3TokenSet = true;
    const result = await svc.status();
    expect(result.providers.map((p) => p.id)).toEqual(["t3-code", "claude-code", "codex", "copilot-cli"]);
    expect(providerOf(result, "t3-code")).toMatchObject({
      cli: null,
      mcp: null,
      models: null,
      t3: { detected: true, origin: "http://127.0.0.1:3773", liveStatus: "ok", tokenSet: true },
    });
  });

  it("scans models only for providers added and on", async () => {
    const models = vi.fn<(harness: string) => Promise<AgentModelsStatus>>((harness) =>
      Promise.resolve({
        harness,
        models: [{ id: "opus", label: "Opus", efforts: null }],
        cliVersion: "2.0.0",
        scannedAt: "2026-11-03T00:00:00.000Z",
        error: null,
      } as unknown as AgentModelsStatus),
    );
    const { svc, settings } = service({}, { models });
    expect(claudeOf(await svc.status()).models).toBeNull();
    expect(models).not.toHaveBeenCalled();
    settings.providers = [
      { id: "claude-code", enabled: true, cliPath: null },
      { id: "copilot-cli", enabled: false, cliPath: null },
    ];
    const result = await svc.status();
    expect(claudeOf(result).models).toEqual({ count: 1, scannedAt: "2026-11-03T00:00:00.000Z", error: null });
    expect(copilotOf(result).models).toBeNull();
    expect(models.mock.calls.map(([harness]) => harness)).toEqual(["claude-code"]);
  });
});

describe("providers: seeding from detection", () => {
  it("adds, once, the providers whose MCP server is registered or whose hand-off entry showed", async () => {
    const { svc, settings, pendSeed, seedPending } = service({
      // Claude Code's and Copilot's CLIs run; Codex's doesn't, but its config has the board.
      resolve: (command) => (command === "codex" ? null : `/bin/${command}`),
      readFile: (path) =>
        path.replace(/\\/g, "/").endsWith("config.toml")
          ? '[mcp_servers.board]\nurl = "http://127.0.0.1:4317/mcp"'
          : null,
    });
    settings.providers = [{ id: "claude-code", enabled: false, cliPath: "/opt/claude" }];
    settings.handoffMenus["copilot-cli"] = true;
    expect(await svc.seedFromDetection()).toEqual([]);
    pendSeed();
    expect(await svc.seedFromDetection()).toEqual(["codex", "copilot-cli"]);
    expect(settings.providers).toEqual([
      { id: "claude-code", enabled: false, cliPath: "/opt/claude" },
      { id: "codex", enabled: true, cliPath: null },
      { id: "copilot-cli", enabled: true, cliPath: null },
    ]);
    expect(seedPending()).toBe(false);
  });

  it("leaves out a CLI the user hid from the hand-off menus, and T3 Code without a token", async () => {
    const { svc, settings, pendSeed, update } = service(
      { claudeMcp: () => Promise.resolve("") },
      { t3: { ...T3_OFF, detected: true } },
    );
    settings.handoffMenus = { "t3-code": true, "claude-code": false, "copilot-cli": false };
    pendSeed();
    expect(await svc.seedFromDetection()).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("GET /api/providers", () => {
  it("serves the status and refreshes on request", async () => {
    const version = vi.fn<(exe: string) => Promise<string>>(() => Promise.resolve("2.0.0"));
    const h = createTestHarness({
      integrations: {
        providerProbes: {
          resolve: (command) => `/bin/${command}`,
          version,
          claudeMcp: () => Promise.resolve("aboard: http://127.0.0.1:4317/mcp (HTTP) - ✓ Connected"),
          readFile: () => null,
        },
      },
    });
    const first = await h.request("/api/providers");
    const body = (await first.json()) as ProvidersStatus;
    expect(body.providers.map((x) => x.id)).toEqual(["t3-code", "claude-code", "codex", "copilot-cli"]);
    expect(body.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    await h.request("/api/providers");
    const calls = version.mock.calls.length;
    await h.request("/api/providers?refresh=1");
    expect(version.mock.calls.length).toBe(calls + 3);
  });
});

describe("providers: the CLI-only answer", () => {
  it("runs no MCP check or model scan, and shares the CLI checks with the full answer", async () => {
    const claudeMcp = vi.fn<ProviderProbes["claudeMcp"]>(() => Promise.resolve(LIST));
    const models = vi.fn<(harness: string) => Promise<AgentModelsStatus>>(() =>
      Promise.reject(new Error("not scanned")),
    );
    const version = vi.fn<(exe: string) => Promise<string>>(() => Promise.resolve("2.0.0"));
    const { svc, settings } = service({ claudeMcp, version }, { models });
    settings.providers = [{ id: "claude-code", enabled: true, cliPath: null }];
    const quick = await svc.status(false, "cli");
    expect(claudeOf(quick)).toMatchObject({ cli: { found: true, version: "2.0.0" }, mcp: null, models: null });
    expect(quick.providers.map((p) => p.id)).toEqual(["t3-code", "claude-code", "codex", "copilot-cli"]);
    expect(claudeMcp).not.toHaveBeenCalled();
    expect(models).not.toHaveBeenCalled();
    expect(version).toHaveBeenCalledTimes(3);
    // The full answer reuses the minute's CLI checks.
    await svc.status();
    expect(version).toHaveBeenCalledTimes(3);
    expect(claudeMcp).toHaveBeenCalled();
  });
});
