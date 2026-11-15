import { randomUUID } from "node:crypto";
import { BRAND, MACHINE_PROTOCOL_VERSION, type MachineDescriptor, type MachineRoute } from "@repo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LINK_CHECK_INTERVAL_MS, createMachineLink, retryDelayMs, type LinkProbe, type LinkState } from "./link.ts";
import type { RouteHandle } from "./tunnel.ts";

const descriptor: MachineDescriptor = {
  id: BRAND.id,
  instanceId: randomUUID(),
  name: "engine",
  version: BRAND.version,
  protocolVersion: MACHINE_PROTOCOL_VERSION,
  role: "runner",
  capabilities: [],
  paired: true,
};
const connected: LinkProbe = { state: "connected", descriptor };

const ssh: MachineRoute = { kind: "ssh", target: "engine", port: null, remotePort: 4318 };
const tailnet: MachineRoute = { kind: "direct", url: "http://100.101.102.103:4318" };

/** Two routes whose reachability the test flips, with every open and close recorded. */
function world(routes: MachineRoute[] = [ssh, tailnet]) {
  const up = new Set<string>(routes.map((r) => r.kind));
  const opened: string[] = [];
  const closed: string[] = [];
  const end = new Map<string, () => void>();
  const states: LinkState[] = [];
  let answer: LinkProbe = connected;
  const link = createMachineLink({
    routes,
    open: (route) => {
      opened.push(route.kind);
      if (route.kind === "ssh" && !up.has("ssh")) return Promise.reject(new Error("ssh engine: Connection refused"));
      const handle: RouteHandle = {
        url: `http://${route.kind}.test`,
        close: () => closed.push(route.kind),
        ended: new Promise<void>((resolve) => end.set(route.kind, resolve)),
      };
      return Promise.resolve(handle);
    },
    probe: (url) => {
      const kind = url.includes("ssh") ? "ssh" : "direct";
      return up.has(kind) ? Promise.resolve(answer) : Promise.reject(new Error(`Nothing answers at ${url}`));
    },
    onChange: (state) => states.push(state),
  });
  return {
    link,
    up,
    opened,
    closed,
    states,
    endTunnel: () => end.get("ssh")?.(),
    answerWith: (probe: LinkProbe) => {
      answer = probe;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a machine's link", () => {
  it("uses the first route that works and leaves the rest on standby", async () => {
    const w = world();
    await w.link.check();
    expect(w.link.state()).toMatchObject({ connection: "connected", error: null, activeRoute: 0 });
    expect(w.link.state().routeStates.map((r) => r.status)).toEqual(["active", "standby"]);
    expect(w.link.url()).toBe("http://ssh.test");
    expect(w.opened).toEqual(["ssh"]);
    w.link.close();
  });

  it("falls to the next route, retries the better one with a growing wait, and moves back when it returns", async () => {
    const w = world();
    w.up.delete("ssh");
    await vi.advanceTimersByTimeAsync(0);
    expect(w.link.state()).toMatchObject({ connection: "connected", activeRoute: 1 });
    expect(w.link.state().routeStates[0]).toMatchObject({ status: "failed", error: "ssh engine: Connection refused" });
    expect(w.link.state().routeStates[0]?.retryAt).not.toBeNull();

    // Each check tries the better route again; it keeps failing, and the wait before the next try grows.
    await vi.advanceTimersByTimeAsync(LINK_CHECK_INTERVAL_MS * 3);
    const tries = w.opened.filter((k) => k === "ssh").length;
    expect(tries).toBeGreaterThan(1);
    expect(w.link.url()).toBe("http://direct.test");

    w.up.add("ssh");
    await vi.advanceTimersByTimeAsync(retryDelayMs(tries) + LINK_CHECK_INTERVAL_MS);
    expect(w.link.state()).toMatchObject({ connection: "connected", activeRoute: 0 });
    // The route it left is closed, and is the standby again.
    expect(w.closed).toContain("direct");
    expect(w.link.state().routeStates.map((r) => r.status)).toEqual(["active", "standby"]);
    w.link.close();
  });

  it("is unreachable when no route works, says why, and comes back by itself", async () => {
    const w = world();
    w.up.clear();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.link.state()).toMatchObject({
      connection: "unreachable",
      activeRoute: null,
      error: "ssh engine: Connection refused",
    });
    expect(w.link.url()).toBeNull();
    w.up.add("direct");
    await vi.advanceTimersByTimeAsync(retryDelayMs(1) + 1_000);
    expect(w.link.state()).toMatchObject({ connection: "connected", activeRoute: 1 });
    w.link.close();
  });

  it("reconnects at once when the tunnel in use ends", async () => {
    const w = world();
    await vi.advanceTimersByTimeAsync(0);
    w.up.delete("ssh");
    w.endTunnel();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.link.state()).toMatchObject({ connection: "connected", activeRoute: 1 });
    expect(w.closed).toContain("ssh");
    w.link.close();
  });

  it("notices on the next check that the route in use stopped answering", async () => {
    const w = world([tailnet]);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.link.state().connection).toBe("connected");
    w.up.clear();
    await vi.advanceTimersByTimeAsync(LINK_CHECK_INTERVAL_MS);
    expect(w.link.state()).toMatchObject({ connection: "unreachable", activeRoute: null });
    w.link.close();
  });

  it("keeps a route to a machine it can't talk to yet, and says which kind", async () => {
    const w = world();
    w.answerWith({ state: "needs-update", descriptor });
    await w.link.check();
    expect(w.link.state()).toMatchObject({ connection: "needs-update", activeRoute: 0 });
    expect(w.link.state().error).toContain("updated");
    w.answerWith({ state: "unpaired", descriptor });
    await w.link.check();
    expect(w.link.state()).toMatchObject({ connection: "unpaired", activeRoute: 0 });
    w.answerWith(connected);
    await w.link.check();
    expect(w.link.state()).toMatchObject({ connection: "connected", error: null });
    w.link.close();
  });

  it("waits 2s, 4s, 8s and at most five minutes between tries", () => {
    expect([1, 2, 3, 20].map(retryDelayMs)).toEqual([2_000, 4_000, 8_000, 300_000]);
  });

  it("reports each change of state once", async () => {
    const w = world();
    await vi.advanceTimersByTimeAsync(LINK_CHECK_INTERVAL_MS * 3);
    // Connecting, then connected; the checks after that change nothing.
    expect(w.states.map((s) => s.connection)).toEqual(["connecting", "connected"]);
    w.link.close();
  });
});
