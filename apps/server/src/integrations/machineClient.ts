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
   * statuses are the caller's to read. `anyProtocol` drops the protocol check, for the one request that is how a
   * mismatch ends: the update.
   */
  request(target: MachineTarget, path: string, init?: RequestInit, options?: MachineRequestOptions): Promise<Response>;
  /** What the runner says our token is good for: the check that a pairing still stands. */
  session(target: MachineTarget): Promise<MachineSession>;
  /** Unpairs: tells the runner to drop our token if it can be reached, and forgets it here either way. */
  unpair(target: MachineTarget): Promise<void>;
}

export interface MachineRequestOptions {
  /** Send even to a runner on another protocol version. Only the update request may: its shape never changes. */
  anyProtocol?: boolean;
  /** How long to wait for the answer, for a request the runner holds open or works on for a while. */
  timeoutMs?: number;
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
  const verified = new Map<string, { instanceId: string; at: number; compatible: boolean }>();

  /**
   * The origins to try, in order. https goes anywhere: the certificate vouches for the host and encrypts the path.
   * Plain http goes only to loopback (an SSH tunnel) or the tailnet (WireGuard), by IP address: a name is resolved
   * here and its addresses used, so what was checked is what is connected to. IPv4 first: every runner listens on
   * it, and a tailnet name resolves to an IPv6 address too.
   */
  async function originsOf(url: string): Promise<string[]> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new MachineClientError("insecure-address", `"${url}" is not a URL`);
    }
    if (parsed.username || parsed.password) {
      throw new MachineClientError("insecure-address", "A machine's URL can't carry a user name or password");
    }
    if (parsed.protocol === "https:") return [parsed.origin];
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
    if (addresses.length === 0 || !addresses.every(safeForPlainHttp)) {
      throw new MachineClientError(
        "insecure-address",
        `${host} isn't on this machine or the tailnet, so plain http to it could be read on the way. ` +
          "Use its Tailscale address, an SSH tunnel or https.",
      );
    }
    return [...new Set(addresses)]
      .toSorted((a, b) => isIP(a) - isIP(b))
      .map((address) => `http://${isIP(address) === 6 ? `[${address}]` : address}:${parsed.port || "80"}`);
  }

  /** One request, never following a redirect: a redirect would carry what we send to an address nobody checked. */
  async function send(
    origin: string,
    path: string,
    init: RequestInit = {},
    timeoutMs: number = TIMEOUT_MS,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await fetchFn(`${origin}${path}`, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
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

  /** The first of `url`'s origins that answers, and who it says it is. */
  async function reach(url: string): Promise<{ origin: string; descriptor: MachineDescriptor }> {
    const origins = await originsOf(url);
    for (const [i, origin] of origins.entries()) {
      try {
        return { origin, descriptor: await describeOrigin(origin) };
      } catch (error) {
        // Only silence moves on to the next address; an answer, right or wrong, is the answer.
        const last = i === origins.length - 1;
        if (last || !(error instanceof MachineClientError) || error.reason !== "unreachable") throw error;
      }
    }
    throw new MachineClientError("unreachable", `Nothing answers at ${url}`);
  }

  /** The origin for `target`, proved (now, or within `VERIFIED_FOR_MS`) to be that runner on our protocol. */
  async function verify(target: MachineTarget, anyProtocol: boolean): Promise<string> {
    const fresh = (origin: string) => {
      const known = verified.get(origin);
      return (
        known?.instanceId === target.instanceId &&
        (known.compatible || anyProtocol) &&
        now().getTime() - known.at < VERIFIED_FOR_MS
      );
    };
    const proved = (await originsOf(target.url)).find(fresh);
    if (proved) return proved;
    const { origin, descriptor } = await reach(target.url);
    requireMachine(descriptor, target.instanceId, origin);
    if (!anyProtocol) requireCompatible(descriptor);
    verified.set(origin, {
      instanceId: target.instanceId,
      at: now().getTime(),
      compatible: machineProtocolCompatible(MACHINE_PROTOCOL_VERSION, descriptor.protocolVersion),
    });
    return origin;
  }

  const messageOf = async (res: Response): Promise<string> => {
    const body = ApiErrorBody.safeParse(await res.json().catch(() => null));
    return body.success ? body.data.error.message : `The machine answered ${res.status}`;
  };

  const client: MachineClient = {
    async describe(url) {
      return (await reach(url)).descriptor;
    },

    async pair(url, code, expectedInstanceId) {
      const { origin, descriptor } = await reach(url);
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

    async request(target, path, init = {}, options = {}) {
      // As the runner will read it: `/machine/../api/board` is not a machine path, and a token goes to no other.
      const { pathname, search, host } = new URL(path, "http://machine.invalid");
      if (host !== "machine.invalid" || !pathname.startsWith("/machine/")) {
        throw new Error(`${path} is not a machine API path`);
      }
      const stored = deps.secrets.get(target.instanceId);
      if (!stored) throw new MachineClientError("not-paired", "This board isn't paired with that machine");
      const origin = await verify(target, options.anyProtocol === true);
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${stored.token}`);
      const res = await send(origin, `${pathname}${search}`, { ...init, headers }, options.timeoutMs).catch(
        (error: unknown) => {
          // Not sent again here, since it may have arrived; but the next call asks afresh who answers where, and so
          // moves on to the name's other addresses.
          verified.delete(origin);
          throw error;
        },
      );
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
