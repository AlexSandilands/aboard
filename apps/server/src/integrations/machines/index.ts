import { randomUUID } from "node:crypto";
import {
  BRAND,
  MACHINE_INSTALL_STEPS,
  MACHINE_PROTOCOL_VERSION,
  MACHINE_STATUS_PATH,
  MACHINE_UPDATE_PATH,
  MachineStatus,
  MachineUpdateState,
  compareReleaseVersions,
  machineProtocolCompatible,
  runnerInstallCommand,
  serverReleaseBaseUrl,
  type ConnectMachineInput,
  type ConnectMachineResult,
  type Machine,
  type MachineInstall,
  type MachineInstallStepKey,
  type MachineRoute,
  type MachinesResponse,
  type SshMachineRoute,
  type UpdateMachineInput,
  type UpdateMachineRequest,
} from "@repo/contracts";
import type { EventBus } from "../../bus.ts";
import type { MachineRecord } from "../../db/repos/machines.ts";
import { AppError } from "../../errors.ts";
import type { Services } from "../../services/types.ts";
import { MachineClientError, type MachineClient, type MachineTarget } from "../machineClient.ts";
import type { MachineSecrets } from "../machineSecrets.ts";
import { messageOf, type Logger } from "../util.ts";
import { SshInstallError, runSshInstall } from "./bootstrap.ts";
import { createMachineLink, type LinkProbe, type LinkState, type MachineLink } from "./link.ts";
import type { SpawnSsh } from "./ssh.ts";
import type { OpenRoute } from "./tunnel.ts";

// The machines a board is connected to, live (docs/features/remote-machines.md#connecting-a-machine): installing a
// runner over SSH, pairing, one link per machine, what each last said of itself, and keeping it on this board's
// version. What is remembered across restarts is services/machines; the tokens are machineSecrets.

export interface MachinesDeps {
  services: () => Services;
  bus: EventBus;
  client: MachineClient;
  secrets: MachineSecrets;
  open: OpenRoute;
  spawnSsh?: SpawnSsh;
  /** Where release files are, instead of GitHub: lets a board run from source install and update a machine. */
  releaseUrl: string | null;
  log?: Logger;
}

export interface MachinesIntegration {
  list(): MachinesResponse;
  /** Connects a machine: by a pairing code, at once; over SSH, as an install to watch in `list().installs`. */
  connect(input: ConnectMachineInput): Promise<ConnectMachineResult>;
  /** Forgets an install that has ended. One still running is left alone. */
  dismissInstall(id: string): void;
  update(id: string, input: UpdateMachineInput): Machine;
  /** Unpairs (telling the runner when it can be reached) and forgets the machine. The runner stays installed there. */
  remove(id: string): Promise<void>;
  /** Tries every route now, whatever their waits. */
  check(id: string): Promise<Machine>;
  /** Pairs again with a machine that dropped this board, by a new code from it. */
  repair(id: string, code: string): Promise<Machine>;
  /** Asks the machine to update to this board's version; `now` doesn't wait for its runs. */
  requestUpdate(id: string, now: boolean): Promise<Machine>;
  /**
   * A request to a connected machine's API, over the route in use. Throws CONFLICT unless the machine is connected:
   * nothing is exchanged with one that is unreachable, unpaired or on another protocol version.
   */
  request(id: string, path: string, init?: RequestInit, options?: { timeoutMs?: number }): Promise<Response>;
  start(): void;
  stop(): void;
}

interface Live {
  link: MachineLink;
  status: MachineStatus | null;
  /** The update last asked for, as the runner answered: all that is known of it while the protocols differ. */
  update: MachineUpdateState | null;
}

const MAX_INSTALLS = 10;
const LOG_TAIL = 4_000;

const snapshot = (job: MachineInstall): MachineInstall => ({ ...job, steps: job.steps.map((s) => ({ ...s })) });

/** A client error as the API reports it: a state the user can change is a CONFLICT, a bad input a VALIDATION. */
function asAppError(error: unknown): unknown {
  if (!(error instanceof MachineClientError)) return error;
  const input = error.reason === "insecure-address" || error.reason === "rejected" || error.reason === "not-a-runner";
  return new AppError(input ? "VALIDATION" : "CONFLICT", error.message);
}

export function createMachinesIntegration(deps: MachinesDeps): MachinesIntegration {
  const log = deps.log ?? console;
  const live = new Map<string, Live>();
  const installs: MachineInstall[] = [];
  let started = false;
  // A board run from source has version 0.0.0, which no release carries.
  const releaseAvailable =
    deps.releaseUrl !== null || (BRAND.version !== "0.0.0" && serverReleaseBaseUrl("0") !== null);

  const machines = () => deps.services().machines;
  const changed = () => deps.bus.publish({ type: "machines.changed" });
  const targetOf = (machine: MachineRecord, url: string): MachineTarget => ({ instanceId: machine.instanceId, url });

  const compose = (record: MachineRecord): Machine => {
    const entry = live.get(record.id);
    const state: LinkState = entry?.link.state() ?? {
      connection: "connecting",
      error: null,
      activeRoute: null,
      routeStates: record.routes.map(() => ({ status: "standby", error: null, retryAt: null })),
    };
    const update = entry?.status?.update ?? entry?.update ?? null;
    const order = record.version === null ? null : compareReleaseVersions(record.version, BRAND.version);
    return {
      id: record.id,
      instanceId: record.instanceId,
      name: record.name,
      prefix: record.prefix,
      prefixFixed: record.prefixFixed,
      routes: record.routes,
      connection: state.connection,
      error: state.error,
      activeRoute: state.activeRoute,
      routeStates: state.routeStates,
      version: record.version,
      protocolVersion: record.protocolVersion,
      platform: record.platform,
      logins: record.logins,
      runsInFlight: entry?.status?.runsInFlight ?? null,
      selfUpdate: entry?.status?.selfUpdate ?? null,
      update: update && update.state !== "idle" ? update : null,
      versionState: order === null ? null : order < 0 ? "older" : order > 0 ? "newer" : "same",
      lastSeenAt: record.lastSeenAt,
      createdAt: record.createdAt,
    };
  };

  /** Who answers at `url`, for `machine`'s link. Read afresh each time: its version is what an update changes. */
  async function probe(machine: MachineRecord, url: string): Promise<LinkProbe> {
    const descriptor = await deps.client.describe(url);
    if (descriptor.instanceId !== machine.instanceId) {
      throw new MachineClientError("wrong-machine", `${descriptor.name} answers there, not ${machine.name}`);
    }
    if (!machineProtocolCompatible(MACHINE_PROTOCOL_VERSION, descriptor.protocolVersion)) {
      return { state: "needs-update", descriptor };
    }
    try {
      await deps.client.session(targetOf(machine, url));
    } catch (error) {
      const reason = error instanceof MachineClientError ? error.reason : null;
      if (reason !== "revoked" && reason !== "not-paired") throw error;
      return { state: "unpaired", descriptor };
    }
    return { state: "connected", descriptor };
  }

  async function sendUpdate(machine: MachineRecord, url: string, now: boolean): Promise<MachineUpdateState> {
    const body: UpdateMachineRequest = { version: BRAND.version, now };
    let state: MachineUpdateState;
    try {
      // The one request sent whatever the protocol versions: it is how a mismatch ends.
      const res = await deps.client.request(
        targetOf(machine, url),
        MACHINE_UPDATE_PATH,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
        { anyProtocol: true },
      );
      const json: unknown = await res.json().catch(() => null);
      const parsed = res.ok ? MachineUpdateState.safeParse(json) : null;
      if (parsed?.success) state = parsed.data;
      else {
        const message = (json as { error?: { message?: unknown } } | null)?.error?.message;
        state = {
          state: "failed",
          targetVersion: BRAND.version,
          error: typeof message === "string" ? message : `The machine answered ${res.status}`,
        };
      }
    } catch (error) {
      state = { state: "failed", targetVersion: BRAND.version, error: messageOf(error) };
    }
    const entry = live.get(machine.id);
    if (entry) {
      entry.update = state;
      // A connected runner's status is what is shown, and it was read before this answer.
      if (entry.status) entry.status = { ...entry.status, update: state };
    }
    return state;
  }

  /** After each pass in which the machine answered: keep what it says, and ask it to update when it is behind. */
  async function reached(id: string, found: LinkProbe, url: string): Promise<void> {
    const entry = live.get(id);
    const machine = machines()
      .list()
      .find((m) => m.id === id);
    if (!entry || !machine) return;
    const { descriptor } = found;
    let status: MachineStatus | null = null;
    if (found.state === "connected" && descriptor.capabilities.includes("status")) {
      try {
        const res = await deps.client.request(targetOf(machine, url), MACHINE_STATUS_PATH);
        status = res.ok ? (MachineStatus.safeParse(await res.json().catch(() => null)).data ?? null) : null;
      } catch (error) {
        log.warn(`[machines] ${machine.name}: couldn't read its status: ${messageOf(error)}`);
      }
    }
    entry.status = status;
    if (status) entry.update = null;
    machines().observe(id, {
      version: descriptor.version,
      protocolVersion: descriptor.protocolVersion,
      platform: status?.platform ?? null,
      logins: status?.logins ?? null,
    });

    const behind = compareReleaseVersions(descriptor.version, BRAND.version) < 0;
    const known = status?.update ?? entry.update;
    const asked = known?.targetVersion === BRAND.version && known.state !== "idle";
    if (
      releaseAvailable &&
      behind &&
      found.state !== "unpaired" &&
      descriptor.capabilities.includes("update") &&
      status?.selfUpdate !== false &&
      // Asked already: a connected runner reports how it goes in its status. One on another protocol is asked
      // again, which is how its answer is read; a failed update waits for the user to retry it.
      !(asked && (found.state === "connected" || known.state === "failed"))
    ) {
      await sendUpdate(machine, url, false);
    }
    changed();
  }

  function startLink(machine: MachineRecord): void {
    live.get(machine.id)?.link.close();
    const entry: Live = {
      status: null,
      update: live.get(machine.id)?.update ?? null,
      link: createMachineLink({
        routes: machine.routes,
        open: deps.open,
        probe: (url) => probe(machine, url),
        onChange: () => changed(),
        onReached: (found, url) => reached(machine.id, found, url),
      }),
    };
    live.set(machine.id, entry);
  }

  const entryOf = (id: string): { machine: MachineRecord; entry: Live } => {
    const machine = machines().get(id);
    if (!live.has(id)) startLink(machine);
    return { machine, entry: live.get(id)! };
  };

  const reachableUrl = (machine: MachineRecord, entry: Live): string => {
    const url = entry.link.url();
    if (!url) throw new AppError("CONFLICT", `${machine.name} can't be reached right now.`);
    return url;
  };

  // Prefixes are stored in capitals; a caller that didn't come through the API's schema may not have them so.
  const prefixOwner = (prefix: string | undefined): MachineRecord | undefined => {
    const wanted = prefix?.trim().toUpperCase();
    return wanted === undefined
      ? undefined
      : machines()
          .list()
          .find((m) => m.prefix === wanted);
  };
  const requireFreePrefix = (prefix: string | undefined): void => {
    const owner = prefixOwner(prefix);
    if (owner) throw new AppError("CONFLICT", `The prefix ${owner.prefix} is ${owner.name}'s. Pick another.`);
  };

  /** Records a machine just paired with, or the new routes of one already known, and (re)starts its link. */
  function remember(input: {
    instanceId: string;
    name: string;
    prefix: string | undefined;
    routes: MachineRoute[];
  }): MachineRecord {
    const known = machines().byInstance(input.instanceId);
    const sameRoute = (a: MachineRoute, b: MachineRoute) =>
      a.kind === "ssh" && b.kind === "ssh"
        ? a.target === b.target
        : a.kind === b.kind && JSON.stringify(a) === JSON.stringify(b);
    let machine: MachineRecord;
    try {
      machine = known
        ? // Connected again (a reinstall, a new code): the routes just used go first, and its name and prefix stay.
          machines().update(known.id, {
            routes: [...input.routes, ...known.routes.filter((r) => !input.routes.some((n) => sameRoute(n, r)))],
          })
        : machines().add({
            ...input,
            // Taken while the install ran: the machine is paired by now, so it gets a suggested one, not an error.
            prefix: prefixOwner(input.prefix) ? undefined : input.prefix,
          });
    } catch (error) {
      // Paired but not stored: nothing would show it or could unpair it, so the token is given up.
      if (!known) deps.secrets.remove(input.instanceId);
      throw error;
    }
    startLink(machine);
    changed();
    return machine;
  }

  async function connectByCode(input: Extract<ConnectMachineInput, { via: "code" }>): Promise<Machine> {
    const url = new URL(input.url).origin;
    let descriptor;
    try {
      // Who is there, before the code is spent: a machine already connected keeps its prefix, whatever was typed.
      const found = await deps.client.describe(url);
      if (!machines().byInstance(found.instanceId)) requireFreePrefix(input.prefix);
      descriptor = await deps.client.pair(url, input.code, found.instanceId);
    } catch (error) {
      throw asAppError(error);
    }
    return compose(
      remember({
        instanceId: descriptor.instanceId,
        name: input.name ?? descriptor.name,
        prefix: input.prefix,
        routes: [{ kind: "direct", url }],
      }),
    );
  }

  function startInstall(input: Extract<ConnectMachineInput, { via: "ssh" }>): MachineInstall {
    // An install onto a machine already connected (found by its SSH destination) keeps that machine's prefix.
    const known = machines()
      .list()
      .find((m) => m.routes.some((r) => r.kind === "ssh" && r.target === input.target));
    if (!known) requireFreePrefix(input.prefix);
    // The install script refuses this too, on what is truly installed; this spares the SSH login when it is known.
    if (known?.version && compareReleaseVersions(known.version, BRAND.version) > 0) {
      throw new AppError(
        "CONFLICT",
        `${known.name} runs ${known.version}, newer than this board (${BRAND.version}). Update the board; a machine is never moved back a version.`,
      );
    }
    if (!releaseAvailable) {
      throw new AppError(
        "CONFLICT",
        `This board runs from source, and version ${BRAND.version} has no release to install on another machine.`,
      );
    }
    const job: MachineInstall = {
      id: randomUUID(),
      target: input.target,
      status: "running",
      steps: MACHINE_INSTALL_STEPS.map((s, i) => ({ ...s, status: i === 0 ? "running" : "pending" })),
      error: null,
      log: "",
      machineId: null,
    };
    // What the caller gets is the install as it starts; the list has it as it goes.
    const initial = snapshot(job);
    installs.unshift(job);
    // Ended installs beyond the last few go; a running one is never dropped.
    for (let i = installs.length - 1; i >= 0 && installs.length > MAX_INSTALLS; i--) {
      if (installs[i]?.status !== "running") installs.splice(i, 1);
    }
    const advance = (key: MachineInstallStepKey) => {
      const at = job.steps.findIndex((s) => s.key === key);
      job.steps.forEach((step, i) => {
        step.status = i < at ? "done" : i === at ? "running" : "pending";
      });
      changed();
    };

    const run = async () => {
      const port = input.port ?? null;
      const result = await runSshInstall(
        { target: input.target, port, version: BRAND.version, tailscale: input.tailscale, baseUrl: deps.releaseUrl },
        {
          onStep: advance,
          onLog: (line) => {
            job.log = `${job.log}${line}\n`.slice(-LOG_TAIL);
          },
        },
        deps.spawnSsh,
      );
      advance("pair");
      const ssh: SshMachineRoute = { kind: "ssh", target: input.target, port, remotePort: result.port };
      const tunnel = await deps.open(ssh);
      let descriptor;
      try {
        // The id the install printed: the tunnel must end at the runner just installed, not at whatever else
        // listens on that port there.
        descriptor = await deps.client.pair(tunnel.url, result.code, result.instanceId);
      } finally {
        tunnel.close();
      }
      advance("connect");
      const machine = remember({
        instanceId: descriptor.instanceId,
        name: input.name ?? descriptor.name,
        prefix: input.prefix,
        routes: [
          ssh,
          ...(result.tailscaleIp
            ? [{ kind: "direct" as const, url: `http://${result.tailscaleIp}:${result.port}` }]
            : []),
        ],
      });
      await live.get(machine.id)?.link.check();
      job.machineId = machine.id;
      job.steps.forEach((step) => (step.status = "done"));
      job.status = "done";
    };
    run()
      .catch((error: unknown) => {
        const running = job.steps.find((s) => s.status === "running");
        if (running) running.status = "failed";
        job.status = "failed";
        job.error = messageOf(error);
        if (
          !(error instanceof SshInstallError) &&
          !(error instanceof MachineClientError) &&
          !(error instanceof AppError)
        ) {
          log.warn(`[machines] install on ${input.target} failed: ${messageOf(error)}`);
        }
      })
      .finally(changed);
    return initial;
  }

  return {
    list: () => ({
      machines: machines().list().map(compose),
      installs: installs.map(snapshot),
      installCommand: runnerInstallCommand(BRAND.version, { baseUrl: deps.releaseUrl }),
      installCommandTailscale: runnerInstallCommand(BRAND.version, { tailscale: true, baseUrl: deps.releaseUrl }),
      releaseAvailable,
    }),

    async connect(input) {
      if (input.via === "code") return { machine: await connectByCode(input), install: null };
      return { machine: null, install: startInstall(input) };
    },

    dismissInstall(id) {
      const at = installs.findIndex((job) => job.id === id && job.status !== "running");
      if (at < 0) return;
      installs.splice(at, 1);
      changed();
    },

    update(id, input) {
      const machine = machines().update(id, input);
      if (input.routes !== undefined || !live.has(id)) startLink(machine);
      changed();
      return compose(machine);
    },

    async remove(id) {
      const machine = machines().get(id);
      const entry = live.get(id);
      const url = entry?.link.url();
      // Told while its route is still open; a machine that can't be reached is unpaired there with `pair revoke`.
      if (url) await deps.client.unpair(targetOf(machine, url));
      else deps.secrets.remove(machine.instanceId);
      entry?.link.close();
      live.delete(id);
      machines().remove(id);
      changed();
    },

    async check(id) {
      const { entry } = entryOf(id);
      await entry.link.check();
      return compose(machines().get(id));
    },

    async repair(id, code) {
      const { machine, entry } = entryOf(id);
      try {
        await deps.client.pair(reachableUrl(machine, entry), code, machine.instanceId);
      } catch (error) {
        throw asAppError(error);
      }
      await entry.link.check();
      return compose(machines().get(id));
    },

    async requestUpdate(id, now) {
      const { machine, entry } = entryOf(id);
      if (!releaseAvailable) {
        throw new AppError("CONFLICT", `Version ${BRAND.version} of this board has no release to update a machine to.`);
      }
      // Migrations only go forward: old code on a database a newer version has migrated may not even start.
      if (machine.version !== null && compareReleaseVersions(machine.version, BRAND.version) > 0) {
        throw new AppError(
          "CONFLICT",
          `${machine.name} runs ${machine.version}, newer than this board (${BRAND.version}). Update the board; a machine is never moved back a version.`,
        );
      }
      await sendUpdate(machine, reachableUrl(machine, entry), now);
      changed();
      return compose(machines().get(id));
    },

    async request(id, path, init, options) {
      const { machine, entry } = entryOf(id);
      const state = entry.link.state();
      if (state.connection !== "connected") {
        throw new AppError("CONFLICT", `${machine.name} isn't connected. ${state.error ?? ""}`.trim());
      }
      try {
        return await deps.client.request(targetOf(machine, reachableUrl(machine, entry)), path, init, options);
      } catch (error) {
        throw asAppError(error);
      }
    },

    start() {
      if (started) return;
      started = true;
      for (const machine of machines().list()) if (!live.has(machine.id)) startLink(machine);
    },

    stop() {
      started = false;
      for (const entry of live.values()) entry.link.close();
      live.clear();
    },
  };
}
