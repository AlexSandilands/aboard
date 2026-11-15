# 0015 A runner's machine API takes paired tokens, and may listen beyond loopback

Status: Accepted

Amends [0003](0003-localhost-guard.md), which stays the rule for everything else.

## Context

[0003](0003-localhost-guard.md) made the server reachable from its own machine only, and ended with "remote or
multi-user hosting would need real auth first". Running tasks on another machine (epic #178,
[remote machines](../features/remote-machines.md)) is that case: the board on one machine has to call the runner
on another, over an SSH tunnel or a Tailscale network.

A tunnel alone would have kept 0003 intact, since its requests arrive from loopback. Tailscale doesn't: the runner
has to listen on an address other machines reach, and once it does, three things 0003 relied on stop holding.

- **The Host header proves nothing.** It stops a browser's DNS rebinding, but any program on the network can
  send `Host: 127.0.0.1`.
- **"Any local process may use the API" becomes "any machine that can connect".** There are no accounts, so
  something has to say which caller is the user's board.
- **The board sends a credential over a network.** It has to know who it is sending it to, and that nobody can
  read it on the way.

## Decision

- **Only a runner changes.** A board binds `127.0.0.1` and follows 0003 unchanged; it refuses to start with
  `brandEnv("BIND")=private`.
- **A runner's identity is its `instanceId`** (`apps/server/src/instance.ts`), the id its data dir already has.
  `GET /machine/descriptor` reports it, with the role and the protocol version, to anyone who asks.
- **The machine API is `/machine/*`, and only on a runner.** The guard (`apps/server/src/http/guard.ts`) requires a
  paired board's token on all of it except the descriptor and the pairing exchange, from loopback too, in an
  `Authorization: Bearer` header only. It refuses every request with an `Origin` (a browser is never a client), and
  a `Host` that isn't an IP address, a local name or a `*.ts.net` name. A route added under `/machine/` is covered
  without doing anything.
- **Everything else stays local.** `/api/*`, `/mcp`, `/events` and the rest keep 0003's Host and Origin rules, and
  are refused to any peer whose socket address isn't loopback, and to any request a proxy forwarded (one carrying
  `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host` or `X-Real-IP`). A machine token opens none of them, and the
  optional `brandEnv("TOKEN")` opens nothing under `/machine/`.
- **Pairing starts on the runner.** `<id>-server pair` writes a one-time code (59 bits, ten minutes, stored
  hashed) into the runner's database. No request can make one. `POST /machine/pair` trades the code for a token;
  ten wrong codes in a minute from one address refuse that address for the rest of it.
- **Tokens are 256 random bits, stored as a SHA-256 hash on the runner** (`machine_tokens`) and listed and revoked
  there with `pair list` and `pair revoke`. The board keeps its copy in `<data dir>/machine-tokens.json`, mode 0600:
  not in `settings`, so not in a backup, a restore or any response to the browser.
- **One board per runner.** A paired runner refuses another board's code with a conflict; the same board pairing
  again replaces its token.
- **`brandEnv("BIND")=private` makes a runner listen on every interface**, IPv4 and IPv6, and drop, before reading anything, any
  connection whose local or remote address isn't loopback, a private range or the tailnet
  (`apps/server/src/http/addresses.ts`). Loopback stays the default; an SSH tunnel needs nothing else.
- **The board's client is the one place a code or token leaves the machine**
  (`apps/server/src/integrations/machineClient.ts`). It sends plain http only to a loopback or tailnet address,
  by IP; https goes anywhere. It reads the descriptor first and sends nothing unless the instance id is the one
  expected and the protocol versions are compatible. It follows no redirect.
- **Compatibility is `MACHINE_PROTOCOL_VERSION`**, not the app version (`packages/contracts/src/machines.ts`).

## Consequences

- A LAN address without Tailscale or a tunnel doesn't work over plain http: the board refuses to send a token
  across a network others can read. The runner still accepts private peers, for a tunnel or proxy that ends on
  one.
- An SSH tunnel makes the runner's whole local API reachable from the board's machine, as 0003 allows any local
  process there. Pairing isn't weakened by it, because making a code takes a login on the runner, and the runner's
  `brandEnv("TOKEN")` closes the rest when that matters.
- The instance id check is against mistakes and stale addresses (a reused tunnel port, a reassigned address), not
  against an attacker who can answer for the address: an id is public. Encryption and the peer's identity come from
  the transport, which is why plain http is limited to loopback and the tailnet.
- 100.64.0.0/10 is treated as the tailnet. It is all of carrier-grade NAT space; a machine whose ISP puts it there
  would count its neighbours as tailnet peers. Tokens are still required of them.
- There are still no accounts or scopes: a paired board may do anything the machine API offers. A second kind of
  client (a phone view, epic #178's backlog) needs scopes first.
- https to a runner means a reverse proxy on its machine, whose every client arrives from loopback. The guard
  refuses what such a proxy forwards outside `/machine/` when the proxy marks it with a forwarding header, as most
  do. One that adds none (nginx by default) is not caught: a proxy must forward `/machine/` and nothing else, or
  the runner's local API is open to whoever reaches the proxy.
- The limit on wrong pairing codes is per address, and everyone behind one tunnel or proxy is one address: a
  client there sending wrong codes keeps the others from pairing while it does.
- Revoking is immediate and final; there is no expiry or rotation. A leaked token works until `pair revoke`.
- New machine routes must be registered under `/machine/` on the runner role, and must not read the token
  themselves: `machinePairingOf(c)` gives the pairing the guard accepted.
- Nothing outside `machineClient.ts` may send a machine token, and nothing may return `machine-tokens.json`'s
  contents through the API.
