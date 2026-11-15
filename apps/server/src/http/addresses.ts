import { isIPv4, isIPv6 } from "node:net";

// Which network an IP address is on, for the two places that decide by it (ADR 0015): the listener of a runner
// bound beyond loopback, which drops peers from the public internet, and the board's machine client, which sends a
// token over plain http only to loopback or the tailnet.

/**
 * - `loopback`: this machine.
 * - `tailnet`: Tailscale's ranges (100.64.0.0/10 and fd7a:115c:a1e0::/48). WireGuard encrypts the path, so plain
 *   http is safe on it. The IPv4 range is all of carrier-grade NAT space, which nothing else on a machine we run on
 *   normally uses.
 * - `private`: a LAN (10/8, 172.16/12, 192.168/16, fc00::/7). Reachable, but anyone on it can read plain http.
 * - `public`: everything else, link-local included, and anything that isn't an IP address.
 */
export type AddressKind = "loopback" | "tailnet" | "private" | "public";

/** Classifies an IP address as a socket or a URL gives it: `[::1]`, `fe80::1%eth0` and `::ffff:10.0.0.1` are fine. */
export function addressKind(address: string): AddressKind {
  const bare = address
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/%.*$/, "")
    .toLowerCase();
  const ip = bare.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  if (isIPv4(ip)) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    if (a === 127) return "loopback";
    if (a === 100 && b >= 64 && b <= 127) return "tailnet";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
    return "public";
  }
  if (!isIPv6(ip)) return "public";
  if (ip === "::1") return "loopback";
  if (ip.startsWith("fd7a:115c:a1e0:")) return "tailnet";
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return "private";
  return "public";
}

/**
 * Whether a runner listening beyond loopback serves this connection: only one that stays on this machine, a LAN or
 * the tailnet. Both ends must be: a cloud VM or a router's port forward hands a public client to a private local
 * address, and a machine with a public address gets private-looking sources only from someone forging them.
 */
export function acceptsPeer(socket: {
  localAddress?: string | undefined;
  remoteAddress?: string | undefined;
}): boolean {
  return [socket.localAddress, socket.remoteAddress].every(
    (address) => address !== undefined && addressKind(address) !== "public",
  );
}
