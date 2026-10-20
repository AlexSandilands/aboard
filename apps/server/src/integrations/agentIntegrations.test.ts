import type { AgentIntegrations } from "@repo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "../test/harness.ts";
import {
  createAgentIntegrations,
  codexMcpEntries,
  mcpEntriesOf,
  parseClaudeMcpList,
  parseClaudeMcpScope,
  sameMcpUrl,
  type AgentIntegrationProbes,
} from "./agentIntegrations.ts";
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

function service(
  probes: Partial<AgentIntegrationProbes>,
  opts: { now?: () => number; env?: Record<string, string> } = {},
) {
  const settings = {
    headlessReviewCli: null as string | null,
    copilotCli: null as string | null,
    codexCli: null as string | null,
  };
  const svc = createAgentIntegrations({
    services: () => ({ settings: { get: () => settings } }) as never,
    mcpUrl: () => BOARD,
    host: () => host(opts.env),
    userHome: "/home/u",
    probes: {
      resolve: (command) => `/bin/${command}`,
      version: () => Promise.resolve("2.0.0"),
      claudeMcp: (_exe, args) => Promise.resolve(args[1] === "get" ? "tasks:\n  Scope: User config\n" : LIST),
      readFile: () => null,
      ...probes,
    },
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { svc, settings };
}

const claudeOf = (r: AgentIntegrations) => r.harnesses.find((h) => h.harness === "claude-code")!;
const copilotOf = (r: AgentIntegrations) => r.harnesses.find((h) => h.harness === "copilot-cli")!;

describe("agent integrations: Claude Code", () => {
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
    settings.headlessReviewCli = "/opt/claude";
    expect(claudeOf(await svc.status(true)).cli.error).toBe("Not found at /opt/claude");

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
    expect(claude.mcp.detail).toContain("timed out");
    expect(claude.mcp.detail).not.toContain("Bearer");
    expect(files.some((f) => f.replace(/\\/g, "/") === "/home/u/.claude.json")).toBe(true);
  });
});

describe("agent integrations: Claude Code local scope", () => {
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
    expect(mcp.detail).toContain("--scope user");
    expect(JSON.stringify(mcp)).not.toContain("secret");
  });
});

describe("agent integrations: Copilot CLI", () => {
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
    expect(copilotOf(await svc.status()).mcp.registered).toBe(true);
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

describe("agent integrations: Codex", () => {
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
    const codex = (await svc.status()).harnesses.find((h) => h.harness === "codex")!;
    expect(codex.cli).toMatchObject({ found: true, path: "/bin/codex" });
    expect(codex.mcp).toMatchObject({ registered: true, name: "my board", scope: "user" });
    const none = (await service({}).svc.status()).harnesses.find((h) => h.harness === "codex")!;
    expect(none.mcp).toMatchObject({ registered: false, detail: "No Codex config yet" });
  });
});

describe("agent integrations: refresh", () => {
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

describe("agent integrations: cache", () => {
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
    settings.copilotCli = "/opt/copilot";
    await svc.status();
    expect(version).toHaveBeenCalledTimes(12);
  });
});

describe("GET /api/agent-integrations", () => {
  it("serves the status and refreshes on request", async () => {
    const version = vi.fn<(exe: string) => Promise<string>>(() => Promise.resolve("2.0.0"));
    const h = createTestHarness({
      integrations: {
        agentIntegrationProbes: {
          resolve: (command) => `/bin/${command}`,
          version,
          claudeMcp: () => Promise.resolve("aboard: http://127.0.0.1:4317/mcp (HTTP) - ✓ Connected"),
          readFile: () => null,
        },
      },
    });
    const first = await h.request("/api/agent-integrations");
    const body = (await first.json()) as AgentIntegrations;
    expect(body.harnesses.map((x) => x.harness)).toEqual(["claude-code", "codex", "copilot-cli"]);
    expect(body.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    await h.request("/api/agent-integrations");
    const calls = version.mock.calls.length;
    await h.request("/api/agent-integrations?refresh=1");
    expect(version.mock.calls.length).toBe(calls + 3);
  });
});
