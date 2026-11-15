import { describe, expect, it } from "vitest";
import { acceptsPeer, addressKind } from "./addresses.ts";

describe("addressKind", () => {
  it("tells this machine, the tailnet, a LAN and the internet apart", () => {
    const kinds = {
      "127.0.0.1": "loopback",
      "127.8.9.10": "loopback",
      "::1": "loopback",
      "[::1]": "loopback",
      "::ffff:127.0.0.1": "loopback",
      "100.64.0.1": "tailnet",
      "100.127.255.254": "tailnet",
      "fd7a:115c:a1e0::1": "tailnet",
      "10.1.2.3": "private",
      "172.16.0.1": "private",
      "172.31.255.1": "private",
      "192.168.1.20": "private",
      "::ffff:192.168.1.20": "private",
      "fd12:3456:789a::1": "private",
      "100.63.255.255": "public",
      "100.128.0.1": "public",
      "172.32.0.1": "public",
      "8.8.8.8": "public",
      "2001:4860:4860::8888": "public",
      // Link-local reaches whoever shares the wire, with no route we chose.
      "169.254.10.10": "public",
      "fe80::1%eth0": "public",
      "example.com": "public",
      "": "public",
    };
    for (const [address, kind] of Object.entries(kinds))
      expect([address, addressKind(address)]).toEqual([address, kind]);
  });
});

describe("acceptsPeer", () => {
  it("serves connections that stay on this machine, a LAN or the tailnet", () => {
    expect(acceptsPeer({ localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" })).toBe(true);
    expect(acceptsPeer({ localAddress: "100.101.102.103", remoteAddress: "100.70.1.2" })).toBe(true);
    expect(acceptsPeer({ localAddress: "::ffff:192.168.1.5", remoteAddress: "::ffff:192.168.1.9" })).toBe(true);
  });

  it("drops a public peer, a public local address, and a socket with no address", () => {
    // A cloud VM or a port forward: the local end looks private, the client is anyone.
    expect(acceptsPeer({ localAddress: "10.0.0.4", remoteAddress: "203.0.113.9" })).toBe(false);
    expect(acceptsPeer({ localAddress: "203.0.113.9", remoteAddress: "10.0.0.4" })).toBe(false);
    expect(acceptsPeer({ localAddress: "10.0.0.4" })).toBe(false);
    expect(acceptsPeer({})).toBe(false);
  });
});
