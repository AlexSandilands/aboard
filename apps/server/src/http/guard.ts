import { MACHINE_DESCRIPTOR_PATH, MACHINE_PAIR_PATH } from "@repo/contracts";
import type { Context, MiddlewareHandler } from "hono";
import { isIP } from "node:net";
import type { Config } from "../config.ts";
import type { MachinePairing } from "../services/machineAuth.ts";
import { addressKind } from "./addresses.ts";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostname(hostHeader: string): string {
  return hostHeader.replace(/:\d+$/, "").toLowerCase();
}

/** True for a localhost origin served by this server or the Vite dev server. */
function isAllowedOrigin(origin: string, config: Pick<Config, "port" | "webPort">): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(host) && !LOCAL_HOSTS.has(`[${host}]`)) return false;
  const originPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return originPort === config.port || originPort === config.webPort;
}

const forbidden = (c: Context, message: string) => c.json({ error: { code: "VALIDATION", message } }, 403);
const unauthorized = (c: Context) => c.json({ error: { code: "VALIDATION", message: "Unauthorized" } }, 401);

/** The address of the socket a request came in on, or null where there is none (`app.request` in tests). */
function peerAddress(c: Context): string | null {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? null;
}

const isMachinePath = (path: string) => path.startsWith("/machine/");

/** The machine API's two routes that take no token: who the runner is, and trading a pairing code for a token. */
const isPublicMachinePath = (path: string) => path === MACHINE_DESCRIPTOR_PATH || path === MACHINE_PAIR_PATH;

/**
 * A Host a runner's machine API answers to: an IP address, a local name or a Tailscale name. A board reaches a
 * runner by address, so its Host isn't a local name, but DNS rebinding needs a name of the attacker's own.
 */
function isMachineHost(hostHeader: string): boolean {
  const host = hostname(hostHeader);
  return LOCAL_HOSTS.has(host) || isIP(host.replace(/^\[(.*)\]$/, "$1")) !== 0 || host.endsWith(".ts.net");
}

const pairings = new WeakMap<Request, MachinePairing>();

/** The pairing whose token the guard accepted for this machine API request. */
export function machinePairingOf(c: Context): MachinePairing {
  const pairing = pairings.get(c.req.raw);
  if (!pairing) throw new Error(`${c.req.path} was not authenticated by the guard`);
  return pairing;
}

export interface GuardOptions {
  config: Pick<Config, "token" | "port" | "webPort"> & Partial<Pick<Config, "role" | "bind">>;
  /** The pairing a machine token belongs to (services.machineAuth.verify). */
  verifyMachineToken: (token: string) => MachinePairing | null;
}

/**
 * The guard every request passes (ADRs 0003 and 0015).
 *
 * Everything but a runner's machine API is local only: it rejects non-local Host headers (DNS rebinding), browser
 * requests from any origin other than this server or the Vite dev server, and, on a runner listening beyond
 * loopback, any peer that isn't this machine; a Host header alone proves nothing there. It enforces the optional
 * bearer token on /api, /mcp and /events. `/mcp/run` (run tools) is not behind the board's token: a run's own token is
 * the credential, so an agent reading untrusted text never holds the board's.
 *
 * A runner's machine API (`/machine/*`) is what a board on another machine calls. It never answers a browser, and
 * everything but the descriptor and the pairing exchange needs a paired board's token, loopback included: an SSH
 * tunnel arrives from loopback too. A machine token is good for nothing else.
 */
export function guard({ config, verifyMachineToken }: GuardOptions): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    const host = c.req.header("host");
    const origin = c.req.header("origin");

    if (config.role === "runner" && isMachinePath(path)) {
      if (origin !== undefined) return forbidden(c, "Forbidden origin");
      if (host && !isMachineHost(host)) return forbidden(c, "Forbidden host");
      if (!isPublicMachinePath(path)) {
        const token = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
        const pairing = token ? verifyMachineToken(token) : null;
        if (!pairing) return unauthorized(c);
        pairings.set(c.req.raw, pairing);
      }
      return next();
    }

    const peer = peerAddress(c);
    // Bound to loopback, the kernel only delivers local peers. Bound wider, a peer we can't see is not let in.
    const local = peer === null ? (config.bind ?? "loopback") === "loopback" : addressKind(peer) === "loopback";
    if (!local) return forbidden(c, "Forbidden peer");
    if (host && !LOCAL_HOSTS.has(hostname(host))) return forbidden(c, "Forbidden host");
    if (origin && !isAllowedOrigin(origin, config)) return forbidden(c, "Forbidden origin");
    if (config.token && (path.startsWith("/api/") || path === "/mcp" || path === "/events") && path !== "/api/health") {
      const auth = c.req.header("authorization");
      const queryToken = c.req.query("token");
      if (auth !== `Bearer ${config.token}` && queryToken !== config.token) return unauthorized(c);
    }
    return next();
  };
}
