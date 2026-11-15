import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, MACHINE_PROTOCOL_VERSION, type MachineDescriptor } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../config.ts";
import { addressKind } from "../http/addresses.ts";
import { runPairCommand } from "../pairCli.ts";
import { startServer, type RunningServer } from "../server.ts";
import { harnessHomesFrom } from "../services/skillSync.ts";
import { MachineClientError, createMachineClient, type MachineClientDeps } from "./machineClient.ts";
import { createMachineSecrets, machineSecretsPath } from "./machineSecrets.ts";

// The board's client against real runners on real sockets: what `pnpm sandbox --runner` gives by hand, here on
// free ports with throwaway data dirs.

const cleanups: Array<() => unknown> = [];

const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), `${BRAND.id}-machine-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function config(overrides: Partial<Config> = {}): Config {
  const homeDir = tempDir();
  return {
    role: "runner",
    port: 0,
    webPort: 5317,
    host: "127.0.0.1",
    bind: "loopback",
    homeDir,
    dbPath: join(homeDir, "data.sqlite"),
    token: null,
    webDist: null,
    t3Home: "/nonexistent",
    pollers: false,
    userHome: "/nonexistent",
    harnessHomes: harnessHomesFrom({}, "/nonexistent"),
    sessionDirs: { claudeDir: "/nonexistent/.claude", copilotDir: "/nonexistent/.copilot" },
    worktreesDir: join(homeDir, "worktrees"),
    attachmentsDir: join(homeDir, "attachments"),
    modelPricesPath: join(homeDir, "model-prices.json"),
    ...overrides,
  };
}

interface Runner {
  server: RunningServer;
  config: Config;
  instanceId: string;
  /** Runs `<id>-server pair …` on the runner's data dir, while it is running, and returns what it printed. */
  cli(...args: string[]): string;
  code(): string;
}

async function startRunner(overrides: Partial<Config> = {}): Promise<Runner> {
  const cfg = config(overrides);
  const server = await startServer(cfg);
  cleanups.push(() => server.close());
  const cli = (...args: string[]) => {
    const lines: string[] = [];
    runPairCommand(args, { config: cfg, out: (line) => lines.push(line) });
    return lines.join("\n");
  };
  const descriptor = (await (await fetch(`${server.url}/machine/descriptor`)).json()) as MachineDescriptor;
  return {
    server,
    config: cfg,
    instanceId: descriptor.instanceId,
    cli,
    code: () => /([2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4})/.exec(cli())![1]!,
  };
}

/** A board's client with its own secrets file, recording every request it makes. */
function board(overrides: Partial<MachineClientDeps> = {}) {
  const path = machineSecretsPath(tempDir());
  const sent: Array<{ url: string; method: string; authorization: string | null; body: string | null }> = [];
  const recordingFetch: typeof fetch = (input, init) => {
    sent.push({
      url: urlOf(input),
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? init.body : null,
    });
    return (overrides.fetch ?? fetch)(input, init);
  };
  const secrets = createMachineSecrets(path);
  const identity = { instanceId: randomUUID(), name: "bridge" };
  const client = createMachineClient({ secrets, board: () => identity, ...overrides, fetch: recordingFetch });
  return { client, secrets, path, sent, identity };
}

const reasonOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "no error";
  } catch (error) {
    if (error instanceof MachineClientError) return error.reason;
    throw error;
  }
};

const listen = (server: Server): Promise<string> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      cleanups.push(() => new Promise((done) => server.close(done)));
      const address = server.address();
      resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
    });
  });

describe("pairing a board with a runner", { timeout: 30_000 }, () => {
  it("pairs with a code from the runner's command, keeps the token in a private file, and opens a session", async () => {
    const runner = await startRunner();
    const { client, secrets, path, identity } = board();
    const paired = await client.pair(runner.server.url, runner.code());
    expect(paired).toMatchObject({ instanceId: runner.instanceId, role: "runner", paired: true });

    const stored = secrets.get(runner.instanceId);
    expect(stored?.token).toBeTruthy();
    expect(process.platform === "win32" ? 0o600 : statSync(path).mode & 0o777).toBe(0o600);

    const target = { instanceId: runner.instanceId, url: runner.server.url };
    expect(await client.session(target)).toMatchObject({ board: identity, tokenId: stored!.tokenId });
    expect(runner.cli("list")).toContain(`${stored!.tokenId}  bridge`);
    // The runner holds only the hash.
    expect(readFileSync(runner.config.dbPath).includes(stored!.token.split(".")[1]!)).toBe(false);
  });

  it("can't reuse a code, and a wrong one is the runner's refusal", async () => {
    const runner = await startRunner();
    const code = runner.code();
    await board().client.pair(runner.server.url, code);
    expect(await reasonOf(board().client.pair(runner.server.url, code))).toBe("rejected");
    expect(await reasonOf(board().client.pair(runner.server.url, "AAAA-AAAA-AAAA"))).toBe("rejected");
  });

  it("a paired runner refuses a second board", async () => {
    const runner = await startRunner();
    await board().client.pair(runner.server.url, runner.code());
    const second = board();
    expect(await reasonOf(second.client.pair(runner.server.url, runner.code()))).toBe("paired-elsewhere");
    expect(second.secrets.get(runner.instanceId)).toBeNull();
  });

  it("revoking on the runner ends the board's access; unpairing from the board ends it on both sides", async () => {
    const runner = await startRunner();
    const bridge = board();
    await bridge.client.pair(runner.server.url, runner.code());
    const target = { instanceId: runner.instanceId, url: runner.server.url };
    const { tokenId, token } = bridge.secrets.get(runner.instanceId)!;

    expect(runner.cli("revoke", tokenId)).toContain("Unpaired");
    expect(await reasonOf(bridge.client.session(target))).toBe("revoked");
    expect(runner.cli("list")).toContain("Not paired");

    await bridge.client.pair(runner.server.url, runner.code());
    await bridge.client.unpair(target);
    expect(bridge.secrets.get(runner.instanceId)).toBeNull();
    expect(await reasonOf(bridge.client.session(target))).toBe("not-paired");
    expect(runner.cli("list")).toContain("Not paired");
    // The old token is dead too, not just forgotten.
    const res = await fetch(`${runner.server.url}/machine/session`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });
});

describe("where the board sends a token", { timeout: 30_000 }, () => {
  it("sends nothing to a runner that isn't the one the token belongs to", async () => {
    const [a, b] = await Promise.all([startRunner(), startRunner()]);
    const bridge = board();
    await bridge.client.pair(a.server.url, a.code());
    bridge.sent.length = 0;
    // A's address now leads to B: a reused tunnel port, a reassigned address.
    expect(await reasonOf(bridge.client.session({ instanceId: a.instanceId, url: b.server.url }))).toBe(
      "wrong-machine",
    );
    expect(bridge.sent.map((r) => [r.url, r.authorization])).toEqual([[`${b.server.url}/machine/descriptor`, null]]);
  });

  it("asks again who is there once the last answer is stale", async () => {
    const [a, b] = await Promise.all([startRunner(), startRunner()]);
    let now = new Date("2026-01-01T00:00:00Z");
    // One address that leads to A, then to B.
    let upstream = a.server.url;
    const moving: typeof fetch = (input, init) => fetch(urlOf(input).replace("http://127.0.0.1:1", upstream), init);
    const bridge = board({ now: () => now, fetch: moving });
    await bridge.client.pair("http://127.0.0.1:1", a.code());
    const target = { instanceId: a.instanceId, url: "http://127.0.0.1:1" };
    await bridge.client.session(target);
    await bridge.client.session(target);
    expect(bridge.sent.filter((r) => r.url.endsWith("/machine/descriptor"))).toHaveLength(2);

    upstream = b.server.url;
    now = new Date(now.getTime() + 31_000);
    expect(await reasonOf(bridge.client.session(target))).toBe("wrong-machine");
    expect(bridge.sent.at(-1)).toMatchObject({ authorization: null });
  });

  it("refuses to pair with a machine other than the one expected, before sending the code", async () => {
    const runner = await startRunner();
    const bridge = board();
    const code = runner.code();
    expect(await reasonOf(bridge.client.pair(runner.server.url, code, randomUUID()))).toBe("wrong-machine");
    expect(bridge.sent.every((r) => r.method === "GET" && !r.body)).toBe(true);
    // The code was never sent, so it still works.
    await bridge.client.pair(runner.server.url, code, runner.instanceId);
  });

  it("blocks on a protocol mismatch before sending a code or a token", async () => {
    const runner = await startRunner();
    let protocolVersion = MACHINE_PROTOCOL_VERSION;
    const newer: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (!urlOf(input).endsWith("/machine/descriptor")) return res;
      return Response.json({ ...((await res.json()) as MachineDescriptor), protocolVersion });
    };
    const bridge = board({ fetch: newer });
    await bridge.client.pair(runner.server.url, runner.code());

    protocolVersion = MACHINE_PROTOCOL_VERSION + 1;
    bridge.sent.length = 0;
    const other = board({ fetch: newer });
    expect(await reasonOf(other.client.pair(runner.server.url, runner.code()))).toBe("protocol-mismatch");
    expect(other.sent.some((r) => r.method === "POST")).toBe(false);
    // A second client, so nothing remembered from before the update hides the mismatch.
    const restarted = createMachineClient({ secrets: bridge.secrets, board: () => bridge.identity, fetch: newer });
    const target = { instanceId: runner.instanceId, url: runner.server.url };
    expect(await reasonOf(restarted.session(target))).toBe("protocol-mismatch");
    // The descriptor itself stays readable, which is how the board shows what needs updating.
    expect((await restarted.describe(runner.server.url)).protocolVersion).toBe(MACHINE_PROTOCOL_VERSION + 1);
  });

  it("follows no redirect", async () => {
    const runner = await startRunner();
    const bridge = board();
    await bridge.client.pair(runner.server.url, runner.code());
    let reached = 0;
    const elsewhere = await listen(
      createServer((_req, res) => {
        reached += 1;
        res.end("{}");
      }),
    );
    const redirecting = await listen(
      createServer((req, res) => {
        res.writeHead(307, { location: `${elsewhere}${req.url}` }).end();
      }),
    );
    expect(await reasonOf(bridge.client.describe(redirecting))).toBe("not-a-runner");
    expect(await reasonOf(bridge.client.pair(redirecting, "AAAA-AAAA-AAAA"))).toBe("not-a-runner");
    expect(await reasonOf(bridge.client.session({ instanceId: runner.instanceId, url: redirecting }))).toBe(
      "not-a-runner",
    );
    expect(reached).toBe(0);
  });

  it("tries a name's next address when the first doesn't answer", async () => {
    const runner = await startRunner();
    const port = new URL(runner.server.url).port;
    // 127.0.0.2 is loopback with nothing listening; the runner is on 127.0.0.1.
    const bridge = board({ resolve: () => Promise.resolve(["127.0.0.2", "127.0.0.1"]) });
    await bridge.client.pair(`http://engine.test:${port}`, runner.code());
    const session = await bridge.client.session({ instanceId: runner.instanceId, url: `http://engine.test:${port}` });
    expect(session.machine.instanceId).toBe(runner.instanceId);
  });

  it("forgets an address that stops answering, so the next call tries the name's others", async () => {
    const [a, standby] = [await startRunner(), await listen(createServer((_req, res) => res.end("{}")))];
    // One name, two addresses on one port; requests to the first reach A until it goes quiet.
    let firstUp = true;
    const routed: typeof fetch = (input, init) => {
      const url = urlOf(input);
      if (url.startsWith("http://127.0.0.1:1/")) {
        return firstUp
          ? fetch(url.replace("http://127.0.0.1:1", a.server.url), init)
          : Promise.reject(new Error("down"));
      }
      return fetch(url.replace("http://127.0.0.2:1", standby), init);
    };
    const bridge = board({ fetch: routed, resolve: () => Promise.resolve(["127.0.0.1", "127.0.0.2"]) });
    await bridge.client.pair("http://engine.test:1", a.code());
    const target = { instanceId: a.instanceId, url: "http://engine.test:1" };
    await bridge.client.session(target);

    firstUp = false;
    expect(await reasonOf(bridge.client.session(target))).toBe("unreachable");
    bridge.sent.length = 0;
    // The second address answers, as something that isn't the runner: it was asked, without the token.
    expect(await reasonOf(bridge.client.session(target))).toBe("not-a-runner");
    expect(bridge.sent.map((r) => [r.url, r.authorization])).toEqual([
      ["http://127.0.0.1:1/machine/descriptor", null],
      ["http://127.0.0.2:1/machine/descriptor", null],
    ]);
  });

  it("sends its token to machine API paths only, however the path is spelled", async () => {
    const runner = await startRunner();
    const bridge = board();
    await bridge.client.pair(runner.server.url, runner.code());
    const target = { instanceId: runner.instanceId, url: runner.server.url };
    bridge.sent.length = 0;
    for (const path of [
      "/api/board",
      "/machine/../api/board",
      "/machine/%2e%2e/api/board",
      "//evil.example/machine/x",
    ]) {
      await expect(bridge.client.request(target, path)).rejects.toThrow(/not a machine API path/);
    }
    expect(bridge.sent).toEqual([]);
    expect((await bridge.client.request(target, "/machine/session?x=1")).status).toBe(200);
  });

  it("says so when the address is a board, something else, or nothing", async () => {
    const boardServer = await startServer(config({ role: "board" }));
    cleanups.push(() => boardServer.close());
    const other = await listen(createServer((_req, res) => res.end("<html>hello</html>")));
    const { client } = board();
    expect(await reasonOf(client.describe(boardServer.url))).toBe("not-a-runner");
    expect(await reasonOf(client.describe(other))).toBe("not-a-runner");
    expect(await reasonOf(client.describe("http://127.0.0.1:9"))).toBe("unreachable");
  });

  it("uses plain http only to loopback or the tailnet, by address", async () => {
    const answered: typeof fetch = () => Promise.reject(new Error("no network in this test"));
    const names: Record<string, string[]> = {
      "engine.tail1234.ts.net": ["100.101.102.103"],
      "engine.lan": ["192.168.1.20"],
      "mixed.example": ["100.101.102.103", "203.0.113.9"],
      localhost: ["127.0.0.1"],
    };
    const bridge = board({ fetch: answered, resolve: (host) => Promise.resolve(names[host] ?? []) });
    const tried = async (url: string) => {
      bridge.sent.length = 0;
      const reason = await reasonOf(bridge.client.describe(url));
      return [reason, bridge.sent[0]?.url ?? null];
    };
    // Allowed ones get as far as the (failing) network, at the address that was checked.
    expect(await tried("http://127.0.0.1:4318")).toEqual(["unreachable", "http://127.0.0.1:4318/machine/descriptor"]);
    expect(await tried("http://[::1]:4318")).toEqual(["unreachable", "http://[::1]:4318/machine/descriptor"]);
    expect(await tried("http://100.101.102.103:4318")).toEqual([
      "unreachable",
      "http://100.101.102.103:4318/machine/descriptor",
    ]);
    expect(await tried("http://engine.tail1234.ts.net:4318/")).toEqual([
      "unreachable",
      "http://100.101.102.103:4318/machine/descriptor",
    ]);
    expect(await tried("http://localhost:4318")).toEqual(["unreachable", "http://127.0.0.1:4318/machine/descriptor"]);
    expect(await tried("https://engine.example.com")).toEqual([
      "unreachable",
      "https://engine.example.com/machine/descriptor",
    ]);
    // A tailnet name has an IPv6 address too, and may list it first; every runner listens on IPv4.
    names["engine.tail1234.ts.net"] = ["fd7a:115c:a1e0::1", "100.101.102.103"];
    await tried("http://engine.tail1234.ts.net:4318");
    expect(bridge.sent.map((r) => r.url)).toEqual([
      "http://100.101.102.103:4318/machine/descriptor",
      "http://[fd7a:115c:a1e0::1]:4318/machine/descriptor",
    ]);
    // A LAN or the internet over plain http: nothing is sent at all.
    for (const url of [
      "http://192.168.1.20:4318",
      "http://10.0.0.5:4318",
      "http://203.0.113.9:4318",
      "http://engine.lan:4318",
      "http://mixed.example:4318",
      "http://unknown.example:4318",
      "http://user:pw@127.0.0.1:4318",
      "ftp://127.0.0.1",
      "not a url",
    ]) {
      expect([url, ...(await tried(url))]).toEqual([url, "insecure-address", null]);
    }
  });
});

/** A private (not loopback) IPv4 address of this machine, if it has one: a way in that isn't loopback. */
function lanAddress(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && ["private", "tailnet"].includes(addressKind(entry.address))) {
        return entry.address;
      }
    }
  }
  return null;
}

/** GET with a Host header of our choosing, which `fetch` won't send. */
const getAs = (address: string, port: number, path: string, host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    httpRequest({ host: address, port, path, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on("error", reject)
      .end();
  });

// Linux and macOS only, like runners: Windows may filter a connection to its own LAN address instead of refusing it.
describe.skipIf(process.platform === "win32")("a runner listening beyond loopback", { timeout: 30_000 }, () => {
  it("stays on loopback unless asked", async (ctx) => {
    const lan = lanAddress();
    if (!lan) return ctx.skip();
    const runner = await startRunner();
    await expect(getAs(lan, runner.server.port, "/machine/descriptor", `${lan}:${runner.server.port}`)).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });

  it("serves the machine API to another address, and nothing else, whatever Host is claimed", async (ctx) => {
    const lan = lanAddress();
    if (!lan) return ctx.skip();
    const runner = await startRunner({ bind: "private" });
    const { port } = runner.server;
    expect(await getAs(lan, port, "/machine/descriptor", `${lan}:${port}`)).toBe(200);
    expect(await getAs(lan, port, "/machine/session", `${lan}:${port}`)).toBe(401);
    // Not loopback, so the board's routes are closed even to a request that says it is local.
    for (const path of ["/api/health", "/api/board", "/events", "/mcp"]) {
      expect([path, await getAs(lan, port, path, `127.0.0.1:${port}`)]).toEqual([path, 403]);
    }
    // From this machine everything works as before.
    expect(await getAs("127.0.0.1", port, "/api/health", `127.0.0.1:${port}`)).toBe(200);
  });
});
