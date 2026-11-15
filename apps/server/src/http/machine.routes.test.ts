import { randomUUID } from "node:crypto";
import { BRAND, MACHINE_PROTOCOL_VERSION, MachineDescriptor, MachineSession, MachineStatus } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.ts";

const TAILNET_HOST = "100.101.102.103:4318";

function runner(overrides: Parameters<typeof createTestHarness>[0] = {}) {
  const h = createTestHarness({ role: "runner", ...overrides });
  const bridge = { instanceId: randomUUID(), name: "bridge" };
  /** A request as a board on the tailnet sends it: the runner's address as Host, no Origin. */
  const remote = (path: string, init: Parameters<typeof h.request>[1] = {}) =>
    h.request(path, { ...init, headers: { host: TAILNET_HOST, ...(init.headers as Record<string, string>) } });
  const pair = async () => {
    const { code } = h.services.machineAuth.createPairingCode();
    const res = await remote("/machine/pair", { method: "POST", json: { code, board: bridge } });
    return (await res.json()) as { token: string; tokenId: string; instanceId: string };
  };
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  return { h, bridge, remote, pair, bearer };
}

describe("machine descriptor", () => {
  it("says who a runner is, without a token, to a board on another machine", async () => {
    const instanceId = randomUUID();
    const { remote } = runner({ instanceId });
    const res = await remote("/machine/descriptor");
    expect(res.status).toBe(200);
    expect(MachineDescriptor.parse(await res.json())).toMatchObject({
      id: BRAND.id,
      instanceId,
      version: BRAND.version,
      protocolVersion: MACHINE_PROTOCOL_VERSION,
      role: "runner",
      capabilities: ["pairing", "status", "update", "tasks", "runs", "t3", "sessions", "autopilot"],
      paired: false,
    });
  });

  it("is served by a board too, to this machine only, and a board has no other machine route", async () => {
    const h = createTestHarness();
    const local = await h.request("/machine/descriptor");
    expect(MachineDescriptor.parse(await local.json())).toMatchObject({ role: "board", capabilities: [] });
    expect((await h.request("/machine/descriptor", { headers: { host: TAILNET_HOST } })).status).toBe(403);
    expect((await h.request("/machine/session")).status).toBe(404);
    const code = h.services.machineAuth.createPairingCode().code;
    const pair = await h.request("/machine/pair", {
      method: "POST",
      json: { code, board: { instanceId: randomUUID(), name: "x" } },
    });
    expect(pair.status).toBe(404);
  });
});

describe("pairing over the machine API", () => {
  it("exchanges a code for a token that opens the session, and reports the runner as paired", async () => {
    const { h, bridge, remote, pair, bearer } = runner();
    const { token, tokenId, instanceId } = await pair();
    expect(instanceId).toBe(h.instanceId);
    const res = await remote("/machine/session", { headers: bearer(token) });
    expect(res.status).toBe(200);
    expect(MachineSession.parse(await res.json())).toMatchObject({
      tokenId,
      board: bridge,
      machine: { instanceId, paired: true },
    });
  });

  it("answers a wrong code with 400 and a second board with 409", async () => {
    const { h, remote, pair } = runner();
    const wrong = await remote("/machine/pair", {
      method: "POST",
      json: { code: "AAAA-AAAA-AAAA", board: { instanceId: randomUUID(), name: "x" } },
    });
    expect(wrong.status).toBe(400);
    await pair();
    const second = await remote("/machine/pair", {
      method: "POST",
      json: {
        code: h.services.machineAuth.createPairingCode().code,
        board: { instanceId: randomUUID(), name: "other" },
      },
    });
    expect(second.status).toBe(409);
    expect(await second.text()).not.toContain("token");
  });

  it("lets the board unpair itself, after which its token is refused", async () => {
    const { remote, pair, bearer } = runner();
    const { token } = await pair();
    expect((await remote("/machine/session", { method: "DELETE", headers: bearer(token) })).status).toBe(204);
    expect((await remote("/machine/session", { headers: bearer(token) })).status).toBe(401);
  });
});

describe("status and updates over the machine API", () => {
  it("answers a paired board with the runner's status, and nobody else", async () => {
    const { remote, pair, bearer } = runner({
      integrations: { runnerHost: { logins: { find: () => null } } },
    });
    expect((await remote("/machine/status")).status).toBe(401);
    const { token } = await pair();
    const res = await remote("/machine/status", { headers: bearer(token) });
    expect(MachineStatus.parse(await res.json())).toMatchObject({
      version: BRAND.version,
      runsInFlight: 0,
      logins: [{ name: "claude", state: "missing" }, { name: "codex" }, { name: "gh" }, { name: "git" }],
      update: { state: "idle" },
      selfUpdate: false,
    });
  });

  it("takes an update request only from its board, for a real version, and says when it can't update itself", async () => {
    const { remote, pair, bearer } = runner();
    const update = (headers: Record<string, string>, json: unknown) =>
      remote("/machine/update", { method: "POST", headers, json });
    expect((await update({}, { version: "9.9.9" })).status).toBe(401);
    const { token } = await pair();
    expect((await update(bearer(token), { version: "../../etc" })).status).toBe(400);
    // A runner under test wasn't installed by the script and runs under no service.
    const refused = await update(bearer(token), { version: "9.9.9" });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("install script");
    // Its own version is nothing to do.
    const same = await update(bearer(token), { version: BRAND.version });
    expect(await same.json()).toMatchObject({ state: "idle" });
  });
});

describe("the guard on a runner", () => {
  it("requires a paired token on every machine route but the descriptor and pairing, loopback included", async () => {
    const { h, remote, pair, bearer } = runner();
    const { token } = await pair();
    for (const path of ["/machine/session", "/machine/anything-added-later"]) {
      expect([path, (await remote(path)).status]).toEqual([path, 401]);
      expect([path, (await h.request(path)).status]).toEqual([path, 401]);
      expect([path, (await remote(path, { headers: bearer("nope.nope") })).status]).toEqual([path, 401]);
      // Not in the URL, where logs and proxies would keep it.
      expect([path, (await remote(`${path}?token=${token}`)).status]).toEqual([path, 401]);
    }
    expect((await remote("/machine/anything-added-later", { headers: bearer(token) })).status).toBe(404);
  });

  it("revoking on the runner locks the board out at once", async () => {
    const { h, remote, pair, bearer } = runner();
    const { token, tokenId } = await pair();
    expect((await remote("/machine/session", { headers: bearer(token) })).status).toBe(200);
    h.services.machineAuth.revoke(tokenId);
    expect((await remote("/machine/session", { headers: bearer(token) })).status).toBe(401);
  });

  it("never answers a browser on the machine API", async () => {
    const { h, remote } = runner();
    for (const origin of ["https://evil.example", "http://127.0.0.1:4317", "null"]) {
      expect((await remote("/machine/descriptor", { headers: { origin } })).status).toBe(403);
      expect((await h.request("/machine/descriptor", { headers: { origin } })).status).toBe(403);
    }
  });

  it("answers the machine API by address or Tailscale name, not by a name an attacker could rebind", async () => {
    const { h } = runner();
    const status = async (host: string) => (await h.request("/machine/descriptor", { headers: { host } })).status;
    expect(await status("127.0.0.1:4318")).toBe(200);
    expect(await status("192.168.1.20:4318")).toBe(200);
    expect(await status("[fd7a:115c:a1e0::1]:4318")).toBe(200);
    expect(await status("engine.tail1234.ts.net")).toBe(200);
    expect(await status("evil.example:4318")).toBe(403);
    expect(await status("ts.net.evil.example")).toBe(403);
  });

  it("keeps everything else local: a machine token opens no board route, and a remote Host is refused", async () => {
    const { h, remote, pair, bearer } = runner({ token: "board-secret" });
    const { token } = await pair();
    expect((await remote("/api/board", { headers: bearer(token) })).status).toBe(403);
    expect((await remote("/mcp", { method: "POST", headers: bearer(token) })).status).toBe(403);
    // Locally the runner's own optional token still rules, and the machine token isn't it.
    expect((await h.request("/api/board", { headers: bearer(token) })).status).toBe(401);
    expect((await h.request("/api/board", { headers: bearer("board-secret") })).status).toBe(200);
    // Nor does the runner's own token open the machine API.
    expect((await remote("/machine/session", { headers: bearer("board-secret") })).status).toBe(401);
  });

  it("refuses what a proxy on its machine forwards to anything but the machine API", async () => {
    const { h, pair, bearer } = runner();
    const { token } = await pair();
    // A reverse proxy's requests come from loopback with a local Host, so only its own headers give it away.
    for (const header of ["x-forwarded-for", "forwarded", "x-real-ip", "x-forwarded-host"]) {
      const forwarded = { [header]: "203.0.113.9" };
      for (const path of ["/api/board", "/api/health", "/events", "/mcp"]) {
        expect([header, path, (await h.request(path, { headers: forwarded })).status]).toEqual([header, path, 403]);
      }
      expect((await h.request("/machine/descriptor", { headers: forwarded })).status).toBe(200);
      expect((await h.request("/machine/session", { headers: forwarded })).status).toBe(401);
      expect((await h.request("/machine/session", { headers: { ...forwarded, ...bearer(token) } })).status).toBe(200);
    }
    // A board is not behind this rule: ADR 0003 stands for it as it was.
    const board = createTestHarness();
    expect((await board.request("/api/health", { headers: { "x-forwarded-for": "203.0.113.9" } })).status).toBe(200);
  });

  it("listening beyond loopback, refuses local-only routes when it can't see that the peer is local", async () => {
    const { h } = runner({ bind: "private" });
    // No socket here, so no peer address: a Host header alone must not be enough.
    expect((await h.request("/api/board")).status).toBe(403);
    expect((await h.request("/api/health")).status).toBe(403);
    expect((await h.request("/machine/descriptor")).status).toBe(200);
  });
});
