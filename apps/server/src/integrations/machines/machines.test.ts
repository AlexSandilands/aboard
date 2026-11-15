import {
  BRAND,
  MACHINE_DESCRIPTOR_PATH,
  MACHINE_PROTOCOL_VERSION,
  MACHINE_STATUS_PATH,
  MACHINE_UPDATE_PATH,
  MachinesResponse,
  RUNNER_INSTALL_RESULT_PREFIX,
  RUNNER_INSTALL_STEP_PREFIX,
  type Machine,
} from "@repo/contracts";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../errors.ts";
import { createTestHarness } from "../../test/harness.ts";
import type { ProbeResult } from "./logins.ts";
import type { SshChild } from "./ssh.ts";

// A board and a runner, each the real app on its own in-memory database. The board's requests are handed straight
// to the runner's app, and `ssh` is a stand-in: the install prints what the script would, and a tunnel's local port
// "reaches" the runner because every request does.

const RUNNER_PORT = 4318;
const TUNNEL_PORT = 45_999;
const TAILNET = "http://100.101.102.103:4318";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(options: { releaseUrl?: string } = {}) {
  const loggedIn: ProbeResult = { code: 0, stdout: "", stderr: "" };
  const runner = createTestHarness({
    role: "runner",
    integrations: {
      // gh is installed and logged in; nothing else is on the PATH.
      runnerHost: {
        logins: { find: (command) => (command === "gh" ? "/usr/bin/gh" : null), run: () => Promise.resolve(loggedIn) },
      },
    },
  });
  runner.services.settings.update({ machineName: "engine" });
  const net = {
    /** Hosts that answer; a request to any other fails as an unreachable machine does. */
    reachable: new Set(["127.0.0.1", "100.101.102.103"]),
    /** Changes the descriptor the board reads, to stand in for a runner on another version. */
    descriptor: (d: Record<string, unknown>): Record<string, unknown> => d,
    /** Changes the status the board reads, to stand in for a runner the install script installed. */
    status: (s: Record<string, unknown>): Record<string, unknown> => s,
    /** What the runner answers an update request with, in place of its own answer. */
    updateAnswer: null as Record<string, unknown> | null,
    sent: [] as Array<{ path: string; method: string; body: string | null }>,
  };
  const fetchFn = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (!net.reachable.has(url.hostname)) throw new TypeError("fetch failed");
    net.sent.push({
      path: url.pathname,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    });
    if (url.pathname === MACHINE_UPDATE_PATH && net.updateAnswer) return Response.json(net.updateAnswer);
    const { signal: _signal, ...rest } = init ?? {};
    const res = await runner.request(`${url.pathname}${url.search}`, {
      ...rest,
      headers: { ...Object.fromEntries(new Headers(init?.headers)), host: url.host },
    });
    if (url.pathname === MACHINE_STATUS_PATH && res.ok) {
      return Response.json(net.status((await res.json()) as Record<string, unknown>));
    }
    if (url.pathname !== MACHINE_DESCRIPTOR_PATH || !res.ok) return res;
    return Response.json(net.descriptor((await res.json()) as Record<string, unknown>));
  }) as typeof fetch;

  const ssh = {
    /** What the install's ssh does: `ok` prints the script's lines, `denied` fails to log in. */
    install: "ok" as "ok" | "denied",
    tailscaleIp: null as string | null,
    tunnels: 0,
    killed: 0,
  };
  const spawn = (args: string[]): SshChild => {
    if (args.includes("-N")) {
      ssh.tunnels += 1;
      let end: (value: { code: number | null }) => void = () => {};
      return {
        onStdout: () => {},
        onStderr: () => {},
        exit: new Promise((resolve) => (end = resolve)),
        kill: () => {
          ssh.killed += 1;
          end({ code: null });
        },
      };
    }
    let out: (text: string) => void = () => {};
    let err: (text: string) => void = () => {};
    return {
      onStdout: (listener) => (out = listener),
      onStderr: (listener) => (err = listener),
      exit: Promise.resolve().then(() => {
        if (ssh.install === "denied") {
          err("alex@engine: Permission denied (publickey).\n");
          return { code: 255 };
        }
        const { code } = runner.services.machineAuth.createPairingCode();
        const pair = {
          code,
          port: RUNNER_PORT,
          instanceId: runner.instanceId,
          name: "engine",
          tailscaleIp: ssh.tailscaleIp,
        };
        const steps = ["download", "verify", "service", "pair"].map((s) => `${RUNNER_INSTALL_STEP_PREFIX}${s}\n`);
        out(`${steps.join("")}Wrote the unit\n${RUNNER_INSTALL_RESULT_PREFIX}${JSON.stringify(pair)}\n`);
        return { code: 0 };
      }),
      kill: () => {},
    };
  };

  const board = createTestHarness({
    ...options,
    integrations: {
      machines: {
        fetch: fetchFn,
        spawn,
        freePort: () => Promise.resolve(TUNNEL_PORT),
        portOpen: () => Promise.resolve(true),
      },
      log: { warn: () => {} },
    },
  });
  const machines = board.integrations.machines;
  cleanups.push(() => machines.stop());

  const installed = async (): Promise<Machine> => {
    await vi.waitFor(() => expect(machines.list().installs[0]?.status).not.toBe("running"));
    const machine = machines.list().machines[0];
    if (!machine) throw new Error(machines.list().installs[0]?.error ?? "no machine");
    return machine;
  };
  const connectByCode = () =>
    machines.connect({ via: "code", url: TAILNET, code: runner.services.machineAuth.createPairingCode().code });
  const reasonOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return "no error";
    } catch (error) {
      if (error instanceof AppError) return `${error.code}: ${error.message}`;
      throw error;
    }
  };
  return { board, runner, machines, net, ssh, installed, connectByCode, reasonOf };
}

describe("connecting a machine over SSH", () => {
  it("installs the runner, pairs through a tunnel and connects, showing each step", async () => {
    const { board, runner, machines, ssh, installed } = setup({ releaseUrl: "http://releases.test" });
    const { install, machine: none } = await machines.connect({ via: "ssh", target: "alex@engine", tailscale: false });
    expect(none).toBeNull();
    expect(install).toMatchObject({ target: "alex@engine", status: "running" });
    expect(install?.steps[0]).toMatchObject({ key: "login", status: "running" });

    const machine = await installed();
    const job = machines.list().installs[0];
    expect(job).toMatchObject({ status: "done", error: null, machineId: machine.id, log: "Wrote the unit\n" });
    expect(job?.steps.every((s) => s.status === "done")).toBe(true);
    expect(machine).toMatchObject({
      name: "engine",
      prefix: "E",
      instanceId: runner.instanceId,
      routes: [{ kind: "ssh", target: "alex@engine", port: null, remotePort: RUNNER_PORT }],
      connection: "connected",
      activeRoute: 0,
      version: BRAND.version,
      protocolVersion: MACHINE_PROTOCOL_VERSION,
      runsInFlight: 0,
      versionState: "same",
      update: null,
    });
    // What is missing on the machine is reported, login by login.
    expect(machine.logins?.map((l) => [l.name, l.state])).toEqual([
      ["claude", "missing"],
      ["codex", "missing"],
      ["gh", "ok"],
      ["git", "missing"],
    ]);
    expect(runner.services.machineAuth.pairings()[0]?.board.instanceId).toBe(board.instanceId);
    // One tunnel for pairing, closed again, and one the link keeps.
    expect(ssh.tunnels).toBe(2);
    expect(ssh.killed).toBe(1);
    expect(board.events.some((e) => e.type === "machines.changed")).toBe(true);

    machines.dismissInstall(job!.id);
    expect(machines.list().installs).toEqual([]);
  });

  it("adds the machine's Tailscale address as a second route when it was asked to listen there", async () => {
    const { machines, ssh, installed } = setup({ releaseUrl: "http://releases.test" });
    ssh.tailscaleIp = "100.101.102.103";
    await machines.connect({ via: "ssh", target: "engine", tailscale: true, name: "Engine room", prefix: "ER" });
    const machine = await installed();
    expect(machine).toMatchObject({ name: "Engine room", prefix: "ER", activeRoute: 0 });
    expect(machine.routes).toEqual([
      { kind: "ssh", target: "engine", port: null, remotePort: RUNNER_PORT },
      { kind: "direct", url: TAILNET },
    ]);
    expect(machine.routeStates.map((r) => r.status)).toEqual(["active", "standby"]);
  });

  it("fails at the step that failed, with what to do, and connects nothing", async () => {
    const { machines, ssh } = setup({ releaseUrl: "http://releases.test" });
    ssh.install = "denied";
    await machines.connect({ via: "ssh", target: "alex@engine", tailscale: false });
    await vi.waitFor(() => expect(machines.list().installs[0]?.status).toBe("failed"));
    const job = machines.list().installs[0];
    expect(job?.error).toContain("ssh-copy-id alex@engine");
    expect(job?.steps.map((s) => s.status)).toEqual(["failed", "pending", "pending", "pending", "pending", "pending"]);
    expect(machines.list().machines).toEqual([]);
  });

  it("is refused onto a machine already connected on a newer version than the board", async () => {
    const { board, machines, ssh, reasonOf } = setup({ releaseUrl: "http://releases.test" });
    const engine = board.services.machines.add({
      instanceId: randomUUID(),
      name: "engine",
      routes: [{ kind: "ssh", target: "alex@engine", port: null, remotePort: RUNNER_PORT }],
    });
    board.services.machines.observe(engine.id, { version: "9.9.9", protocolVersion: MACHINE_PROTOCOL_VERSION });
    expect(await reasonOf(machines.connect({ via: "ssh", target: "alex@engine", tailscale: false }))).toMatch(
      /^CONFLICT: .*never moved back/,
    );
    expect(machines.list().installs).toEqual([]);
    expect(ssh.tunnels).toBe(0);
  });

  it("is refused on a board run from source, which has no release to install", async () => {
    const { machines, reasonOf } = setup();
    expect(machines.list().releaseAvailable).toBe(false);
    expect(await reasonOf(machines.connect({ via: "ssh", target: "engine", tailscale: false }))).toMatch(
      /^CONFLICT: .*from source/,
    );
  });
});

describe("connecting a machine by its pairing code", () => {
  it("pairs at the address given and uses it as the route", async () => {
    const { connectByCode, machines } = setup();
    const { machine } = await connectByCode();
    expect(machine).toMatchObject({ name: "engine", prefix: "E", routes: [{ kind: "direct", url: TAILNET }] });
    expect(await machines.check(machine!.id)).toMatchObject({ connection: "connected", activeRoute: 0, error: null });
  });

  it("refuses a wrong code, an address that isn't safe for plain http, and a prefix in use", async () => {
    const { board, machines, reasonOf, runner } = setup();
    expect(await reasonOf(machines.connect({ via: "code", url: TAILNET, code: "AAAA-AAAA-AAAA" }))).toMatch(
      /^VALIDATION: .*wrong/,
    );
    expect(await reasonOf(machines.connect({ via: "code", url: "http://192.168.1.20:4318", code: "x" }))).toMatch(
      /^VALIDATION: .*tailnet/,
    );
    // Another machine has the prefix; the runner isn't known yet, so the code isn't even spent.
    board.services.machines.add({
      instanceId: randomUUID(),
      name: "x-ray",
      prefix: "X",
      routes: [{ kind: "direct", url: "http://100.9.9.9:4318" }],
    });
    const code = runner.services.machineAuth.createPairingCode().code;
    expect(await reasonOf(machines.connect({ via: "code", url: TAILNET, code, prefix: "x" }))).toMatch(
      /^CONFLICT: .*prefix/,
    );
    expect((await machines.connect({ via: "code", url: TAILNET, code })).machine).toMatchObject({ prefix: "E" });
  });

  it("connecting the same machine again keeps it one machine, with the new route first", async () => {
    const { machines, connectByCode, runner } = setup();
    const { machine } = await connectByCode();
    const code = runner.services.machineAuth.createPairingCode().code;
    // Its own prefix typed again is not a prefix "in use".
    await machines.connect({
      via: "code",
      url: "http://127.0.0.1:4318",
      code,
      name: "ignored",
      prefix: machine!.prefix,
    });
    const list = machines.list().machines;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: machine!.id, name: machine!.name });
    expect(list[0]?.routes.map((r) => (r.kind === "direct" ? r.url : r.target))).toEqual([
      "http://127.0.0.1:4318",
      TAILNET,
    ]);
  });
});

describe("a connected machine", () => {
  it("is unreachable while nothing answers and connected again when it does", async () => {
    const { machines, connectByCode, net } = setup();
    const id = (await connectByCode()).machine!.id;
    net.reachable.clear();
    expect(await machines.check(id)).toMatchObject({ connection: "unreachable", activeRoute: null });
    expect((await machines.check(id)).error).toContain("Nothing answers");
    expect(await reasonOf(machines.request(id, "/machine/session"))).toMatch(/^CONFLICT: .*isn't connected/);
    net.reachable.add("100.101.102.103");
    expect(await machines.check(id)).toMatchObject({ connection: "connected", error: null });
    expect((await machines.request(id, "/machine/session")).status).toBe(200);

    async function reasonOf(promise: Promise<unknown>) {
      try {
        await promise;
        return "no error";
      } catch (error) {
        return error instanceof AppError ? `${error.code}: ${error.message}` : String(error);
      }
    }
  });

  it("that dropped this board is unpaired until it is paired again with a new code", async () => {
    const { machines, connectByCode, runner, reasonOf } = setup();
    const id = (await connectByCode()).machine!.id;
    runner.services.machineAuth.revokeAll();
    expect(await machines.check(id)).toMatchObject({ connection: "unpaired", activeRoute: 0 });
    expect(await reasonOf(machines.repair(id, "AAAA-AAAA-AAAA"))).toMatch(/^VALIDATION/);
    const repaired = await machines.repair(id, runner.services.machineAuth.createPairingCode().code);
    expect(repaired).toMatchObject({ connection: "connected", error: null });
  });

  it("on another protocol version needs updating: nothing is exchanged with it but the update request", async () => {
    const { machines, connectByCode, net, reasonOf } = setup({ releaseUrl: "http://releases.test" });
    const id = (await connectByCode()).machine!.id;
    await machines.check(id);
    net.descriptor = (d) => ({ ...d, protocolVersion: MACHINE_PROTOCOL_VERSION + 1, version: "0.0.0-old" });
    const failed = { state: "failed", targetVersion: BRAND.version, error: "The download doesn't match its checksum" };
    net.updateAnswer = failed;
    net.sent.length = 0;
    const machine = await machines.check(id);
    expect(machine).toMatchObject({
      connection: "needs-update",
      activeRoute: 0,
      versionState: "older",
      version: "0.0.0-old",
    });
    expect(machine.error).toContain("updated");
    // The board asked it to update, by itself, and shows what the runner answered.
    const update = net.sent.find((s) => s.path === MACHINE_UPDATE_PATH);
    expect(JSON.parse(update?.body ?? "{}")).toEqual({ version: BRAND.version, now: false });
    expect(machine.update).toEqual(failed);
    // Its status isn't read, and no other request reaches it.
    expect(
      net.sent.map((s) => s.path).filter((p) => p !== MACHINE_DESCRIPTOR_PATH && p !== MACHINE_UPDATE_PATH),
    ).toEqual([]);
    expect(await reasonOf(machines.request(id, "/machine/session"))).toMatch(/^CONFLICT: .*isn't connected/);

    // A failed update isn't asked for again by itself, only when the user does.
    net.sent.length = 0;
    await machines.check(id);
    expect(net.sent.some((s) => s.path === MACHINE_UPDATE_PATH)).toBe(false);
    await machines.requestUpdate(id, true);
    expect(JSON.parse(net.sent.find((s) => s.path === MACHINE_UPDATE_PATH)?.body ?? "{}")).toEqual({
      version: BRAND.version,
      now: true,
    });

    // Updated: it speaks our protocol again and is connected.
    net.descriptor = (d) => d;
    expect(await machines.check(id)).toMatchObject({ connection: "connected", versionState: "same", update: null });
  });

  it("that is behind the board is asked to update once, and not again while it says it is waiting", async () => {
    const { machines, connectByCode, net } = setup({ releaseUrl: "http://releases.test" });
    const id = (await connectByCode()).machine!.id;
    const waiting = { state: "waiting", targetVersion: BRAND.version, error: null };
    net.descriptor = (d) => ({ ...d, version: "0.0.0-old" });
    net.updateAnswer = waiting;
    net.sent.length = 0;
    const asked = () => net.sent.filter((s) => s.path === MACHINE_UPDATE_PATH).map((s) => JSON.parse(s.body ?? "{}"));
    // A runner the install script installed, which reports the update it was asked for, as a real one does.
    net.status = (s) => ({
      ...s,
      version: "0.0.0-old",
      selfUpdate: true,
      runsInFlight: 2,
      ...(asked().length > 0 ? { update: waiting } : {}),
    });

    expect(await machines.check(id)).toMatchObject({ connection: "connected", versionState: "older", update: waiting });
    expect(asked()).toEqual([{ version: BRAND.version, now: false }]);

    // From here its status says how the update goes.
    expect(await machines.check(id)).toMatchObject({ update: waiting, runsInFlight: 2 });
    expect(asked()).toHaveLength(1);

    // The user not waiting for the runs is a second request, with `now`.
    await machines.requestUpdate(id, true);
    expect(asked().at(-1)).toEqual({ version: BRAND.version, now: true });
  });

  it("that can't update itself, or is newer than the board, is never asked to", async () => {
    const { machines, connectByCode, net, reasonOf } = setup({ releaseUrl: "http://releases.test" });
    const id = (await connectByCode()).machine!.id;
    const asked = () => net.sent.some((s) => s.path === MACHINE_UPDATE_PATH);
    // Behind, but not installed by the script (what the runner under test truly is).
    net.descriptor = (d) => ({ ...d, version: "0.0.0-old" });
    expect(await machines.check(id)).toMatchObject({ versionState: "older", selfUpdate: false, update: null });
    expect(asked()).toBe(false);
    // Newer: left alone, and the board refuses to send it back a version even when asked to.
    net.descriptor = (d) => ({ ...d, version: "9.9.9" });
    net.status = (s) => ({ ...s, version: "9.9.9", selfUpdate: true });
    expect(await machines.check(id)).toMatchObject({ versionState: "newer", update: null });
    expect(await reasonOf(machines.requestUpdate(id, true))).toMatch(/^CONFLICT: .*never moved back/);
    expect(asked()).toBe(false);
  });

  it("is renamed, re-prefixed and re-routed, and removing it unpairs the runner", async () => {
    const { machines, connectByCode, runner } = setup();
    const id = (await connectByCode()).machine!.id;
    await machines.check(id);
    const routes = [
      { kind: "ssh" as const, target: "engine", port: null, remotePort: RUNNER_PORT },
      { kind: "direct" as const, url: TAILNET },
    ];
    expect(machines.update(id, { name: "Engine", prefix: "EN", routes })).toMatchObject({
      name: "Engine",
      prefix: "EN",
      routes,
    });
    expect(await machines.check(id)).toMatchObject({ connection: "connected", activeRoute: 0 });
    expect(runner.services.machineAuth.paired()).toBe(true);
    await machines.remove(id);
    expect(machines.list().machines).toEqual([]);
    expect(runner.services.machineAuth.paired()).toBe(false);
  });
});

describe("the machines API", () => {
  it("lists machines with the commands for installing by hand, and connects one by code", async () => {
    const { board, runner } = setup();
    const empty = MachinesResponse.parse(await (await board.request("/api/machines")).json());
    expect(empty).toMatchObject({ machines: [], installs: [], releaseAvailable: false });
    expect(empty.installCommand).toContain(`/v${BRAND.version}/install-runner.sh | sh`);
    expect(empty.installCommandTailscale).toContain("--tailscale");

    const code = runner.services.machineAuth.createPairingCode().code;
    const created = await board.request("/api/machines", { method: "POST", json: { via: "code", url: TAILNET, code } });
    expect(created.status).toBe(201);
    const { machine } = (await created.json()) as { machine: Machine };
    const checked = await board.request(`/api/machines/${machine.id}/check`, { method: "POST" });
    expect(await checked.json()).toMatchObject({ connection: "connected" });
    const renamed = await board.request(`/api/machines/${machine.id}`, { method: "PATCH", json: { prefix: "x9" } });
    expect(await renamed.json()).toMatchObject({ prefix: "X9" });
    expect((await board.request(`/api/machines/${machine.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await board.request("/api/machines/nope/check", { method: "POST" })).status).toBe(404);
  });

  it("is a board's: a runner has no machines to connect to", async () => {
    const { runner } = setup();
    expect((await runner.request("/api/machines")).status).toBe(404);
  });
});

describe("a runner's status", () => {
  it("tells its board its version, platform, runs, logins and whether it can update itself", async () => {
    const { machines, connectByCode } = setup();
    const id = (await connectByCode()).machine!.id;
    const res = await machines.request(id, "/machine/status").catch(async () => {
      await machines.check(id);
      return machines.request(id, "/machine/status");
    });
    expect(await res.json()).toMatchObject({
      version: BRAND.version,
      runsInFlight: 0,
      update: { state: "idle", targetVersion: null, error: null },
      selfUpdate: false,
    });
  });
});
