import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  ApiErrorBody,
  BRAND,
  MACHINE_DESCRIPTOR_PATH,
  MACHINE_PAIR_PATH,
  MACHINE_PROTOCOL_VERSION,
  MACHINE_SESSION_PATH,
  MachineDescriptor,
  MachineSession,
  PairMachineResult,
  machineProtocolCompatible,
  type PairMachineInput,
  type PairedBoard,
} from "@repo/contracts";
import { addressKind } from "../http/addresses.ts";
import type { MachineSecrets } from "./machineSecrets.ts";

// The board's side of the machine API (docs/features/remote-machines.md#the-boards-client, ADR 0015): the only code
// that sends a pairing code or a token to another machine, and the rules for when it may.

export type MachineClientErrorReason =
  /** Plain http to somewhere that isn't loopback or the tailnet, or not a URL we can use. */
  | "insecure-address"
  /** Nothing answered, or it timed out. */
  | "unreachable"
  /** Something answered that isn't a runner of ours. */
  | "not-a-runner"
  /** A runner answered, but not the one this token belongs to. Nothing was sent to it. */
  | "wrong-machine"
  /** The runner speaks another protocol version; one side needs updating first. */
  | "protocol-mismatch"
  /** This board holds no token for the runner. */
  | "not-paired"
  /** The runner no longer accepts our token: it was unpaired there. */
  | "revoked"
  /** The runner is paired with another board. */
  | "paired-elsewhere"
  /** The runner refused, with its reason as the message (a wrong pairing code, say). */
  | "rejected";

export class MachineClientError extends Error {
  constructor(
    readonly reason: MachineClientErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "MachineClientError";
  }
}

/** A runner the board knows: who it must be, and one address to reach it at. */
export interface MachineTarget {
  instanceId: string;
  /** `http://100.101.102.103:4318`, an SSH tunnel's `http://127.0.0.1:<port>`, or an https URL. */
  url: string;
}

export interface MachineClientDeps {
  secrets: MachineSecrets;
  /** Who this board is, sent when pairing. */
  board: () => PairedBoard;
  fetch?: typeof fetch;
  /** Every address a host name resolves to; tests swap in their own. */
  resolve?: (hostname: string) => Promise<string[]>;
  now?: () => Date;
}

export interface MachineClient {
  /**
   * Who answers at `url`: its descriptor, read with no credentials. Throws `not-a-runner` unless it is a runner of
   * ours; the caller decides what a protocol mismatch means for it.
   */
  describe(url: string): Promise<MachineDescriptor>;
  /**
   * Pairs with the runner at `url` using a code its user got from `<id>-server pair`, and stores the token. With
   * `expectedInstanceId` (pairing again with a machine the board knows) any other runner is refused before the
   * code is sent.
   */
  pair(url: string, code: string, expectedInstanceId?: string): Promise<MachineDescriptor>;
  /**
   * A request to a paired runner's machine API with the board's token. The token is sent only once the address has
   * answered, just now, as the runner it belongs to, on a compatible protocol. A 401 throws `revoked`; other
   * statuses are the caller's to read.
   */
  request(target: MachineTarget, path: string, init?: RequestInit): Promise<Response>;
  /** What the runner says our token is good for: the check that a pairing still stands. */
  session(target: MachineTarget): Promise<MachineSession>;
  /** Unpairs: tells the runner to drop our token if it can be reached, and forgets it here either way. */
  unpair(target: MachineTarget): Promise<void>;
}

const TIMEOUT_MS = 10_000;
/** How long an address counts as the runner it last proved to be, before it is asked again. */
const VERIFIED_FOR_MS = 30_000;

async function resolveAll(hostname: string): Promise<string[]> {
  return (await dnsLookup(hostname, { all: true })).map((a) => a.address);
}

const safeForPlainHttp = (address: string) => {
  const kind = addressKind(address);
  return kind === "loopback" || kind === "tailnet";
};

export function createMachineClient(deps: MachineClientDeps): MachineClient {
  const fetchFn = deps.fetch ?? fetch;
  const resolve = deps.resolve ?? resolveAll;
  const now = deps.now ?? (() => new Date());
  /** Origin → the instance id it proved to be, and when. */
  const verified = new Map<string, { instanceId: string; at: number }>();

  /**
   * The origin to talk to. https goes anywhere: the certificate vouches for the host and encrypts the path. Plain
   * http goes only to loopback (an SSH tunnel) or the tailnet (WireGuard), by IP address: a name is resolved here
   * and the address used, so what was checked is what is connected to.
   */
  async function originOf(url: string): Promise<string> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new MachineClientError("insecure-address", `"${url}" is not a URL`);
    }
    if (parsed.username || parsed.password) {
      throw new MachineClientError("insecure-address", "A machine's URL can't carry a user name or password");
    }
    if (parsed.protocol === "https:") return parsed.origin;
    if (parsed.protocol !== "http:") {
      throw new MachineClientError("insecure-address", `A machine's URL is http or https, not ${parsed.protocol}`);
    }
    const host = parsed.hostname;
    const literal = host.replace(/^\[(.*)\]$/, "$1");
    let addresses: string[];
    if (isIP(literal)) addresses = [literal];
    else {
      try {
        addresses = await resolve(host);
      } catch {
        throw new MachineClientError("unreachable", `Can't find ${host}`);
      }
    }
    const address = addresses[0];
    if (!address || !addresses.every(safeForPlainHttp)) {
      throw new MachineClientError(
        "insecure-address",
        `${host} isn't on this machine or the tailnet, so plain http to it could be read on the way. ` +
          "Use its Tailscale address, an SSH tunnel or https.",
      );
    }
    return `http://${isIP(address) === 6 ? `[${address}]` : address}:${parsed.port || "80"}`;
  }

  /** One request, never following a redirect: a redirect would carry what we send to an address nobody checked. */
  async function send(origin: string, path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetchFn(`${origin}${path}`, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new MachineClientError("unreachable", `Nothing answers at ${origin}`);
    }
    if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
      throw new MachineClientError("not-a-runner", `${origin} answered with a redirect, which a runner never does`);
    }
    return res;
  }

  async function describeOrigin(origin: string): Promise<MachineDescriptor> {
    verified.delete(origin);
    const res = await send(origin, MACHINE_DESCRIPTOR_PATH);
    const parsed = res.ok ? MachineDescriptor.safeParse(await res.json().catch(() => null)) : null;
    if (!parsed?.success || parsed.data.id !== BRAND.id || parsed.data.role !== "runner") {
      throw new MachineClientError("not-a-runner", `${origin} isn't a ${BRAND.name} runner`);
    }
    return parsed.data;
  }

  function requireCompatible(descriptor: MachineDescriptor): void {
    if (machineProtocolCompatible(MACHINE_PROTOCOL_VERSION, descriptor.protocolVersion)) return;
    throw new MachineClientError(
      "protocol-mismatch",
      `${descriptor.name} speaks machine protocol ${descriptor.protocolVersion} (version ${descriptor.version}) and ` +
        `this board ${MACHINE_PROTOCOL_VERSION} (version ${BRAND.version}); update the older one`,
    );
  }

  function requireMachine(descriptor: MachineDescriptor, instanceId: string, origin: string): void {
    if (descriptor.instanceId === instanceId) return;
    throw new MachineClientError(
      "wrong-machine",
      `${origin} is ${descriptor.name}, not the machine expected there; nothing was sent to it`,
    );
  }

  /** The origin for `target`, proved (now, or within `VERIFIED_FOR_MS`) to be that runner on our protocol. */
  async function verify(target: MachineTarget): Promise<string> {
    const origin = await originOf(target.url);
    const known = verified.get(origin);
    if (known?.instanceId === target.instanceId && now().getTime() - known.at < VERIFIED_FOR_MS) return origin;
    const descriptor = await describeOrigin(origin);
    requireMachine(descriptor, target.instanceId, origin);
    requireCompatible(descriptor);
    verified.set(origin, { instanceId: target.instanceId, at: now().getTime() });
    return origin;
  }

  const messageOf = async (res: Response): Promise<string> => {
    const body = ApiErrorBody.safeParse(await res.json().catch(() => null));
    return body.success ? body.data.error.message : `The machine answered ${res.status}`;
  };

  const client: MachineClient = {
    async describe(url) {
      return describeOrigin(await originOf(url));
    },

    async pair(url, code, expectedInstanceId) {
      const origin = await originOf(url);
      const descriptor = await describeOrigin(origin);
      if (expectedInstanceId) requireMachine(descriptor, expectedInstanceId, origin);
      requireCompatible(descriptor);
      const input: PairMachineInput = { code, board: deps.board() };
      const res = await send(origin, MACHINE_PAIR_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        throw new MachineClientError(res.status === 409 ? "paired-elsewhere" : "rejected", await messageOf(res));
      }
      const result = PairMachineResult.safeParse(await res.json().catch(() => null));
      // The token belongs to whoever answered the descriptor; an answer naming another machine is not kept.
      if (!result.success || result.data.instanceId !== descriptor.instanceId) {
        throw new MachineClientError("not-a-runner", `${origin} gave an answer to pairing that can't be used`);
      }
      deps.secrets.set(descriptor.instanceId, {
        token: result.data.token,
        tokenId: result.data.tokenId,
        pairedAt: now().toISOString(),
      });
      return { ...descriptor, paired: true };
    },

    async request(target, path, init = {}) {
      if (!path.startsWith("/machine/")) throw new Error(`${path} is not a machine API path`);
      const stored = deps.secrets.get(target.instanceId);
      if (!stored) throw new MachineClientError("not-paired", "This board isn't paired with that machine");
      const origin = await verify(target);
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${stored.token}`);
      const res = await send(origin, path, { ...init, headers });
      if (res.status === 401) {
        verified.delete(origin);
        throw new MachineClientError("revoked", "The machine no longer accepts this board; pair it again");
      }
      return res;
    },

    async session(target) {
      const res = await client.request(target, MACHINE_SESSION_PATH);
      const parsed = res.ok ? MachineSession.safeParse(await res.json().catch(() => null)) : null;
      if (!parsed?.success) throw new MachineClientError("rejected", await messageOf(res));
      return parsed.data;
    },

    async unpair(target) {
      try {
        if (deps.secrets.get(target.instanceId))
          await client.request(target, MACHINE_SESSION_PATH, { method: "DELETE" });
      } catch (error) {
        // Unreachable or already revoked: the token is forgotten here regardless, and `pair revoke` on the machine
        // ends it there.
        if (!(error instanceof MachineClientError)) throw error;
      } finally {
        deps.secrets.remove(target.instanceId);
      }
    },
  };
  return client;
}
