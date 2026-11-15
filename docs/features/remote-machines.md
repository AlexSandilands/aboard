# Remote machines

Board tasks: #179, #180, in epic #178 (run tasks on another machine).

A task can be set to run on another machine: a server or a second computer the board connects to. That machine
runs the same server as the board, started in the **runner** role: it serves no board or web app, holds the
tasks sent to it, and runs their agents. This page covers the part that exists so far: the runner role, the
release that puts the server on a machine with nothing installed, the background service that keeps it
running, and how a board and a runner come to trust each other: identity, pairing, tokens and the machine API.
Connecting a machine from the board, held tasks and remote runs aren't built yet; they are the later tasks of
epic #178.

## How it works

### The runner role

`<id>-server --runner` (or `brandEnv("ROLE")=runner`) starts the server in the runner role. `loadConfig` sets
`Config.role`, and a runner has no `webDist`, so nothing but the API, `/events` and `/mcp` is served: `/` is a 404.
Everything else is the same server: the same database and migrations, and by default the same `127.0.0.1` binding
([listening beyond loopback](#listening-beyond-loopback) is a runner's option). A
runner has its own defaults, so it can run on a machine that also has the desktop app without sharing its database
or locking it out of its port:

| Setting                       | Board     | Runner           |
| ----------------------------- | --------- | ---------------- |
| Data dir, `brandEnv("HOME")`  | `~/.<id>` | `~/.<id>-runner` |
| Port, `brandEnv("PORT")`      | 4317      | 4318             |

Either variable still overrides the default.

`GET /api/health` reports the role:

```json
{ "ok": true, "id": "<id>", "version": "1.4.2", "role": "runner" }
```

`Health.role` (`packages/contracts/src/schemas.ts`) defaults to `board` when missing, which is what servers from
before runners were. Clients that look for a board check it:

- the desktop shell attaches to a server on its port only when it is a board; a runner there counts as another app
  (`isOwnHealth`, [desktop](desktop.md#attach-or-spawn));
- the sandbox waits for each of its servers by role.

### The release

The release has a tarball per platform, `<id>-server-<version>-<platform>.tar.gz` for `linux-x64`, `linux-arm64`
and `darwin-arm64`, with `SHA256SUMS-server.txt`. Each carries its own Node runtime, so the machine needs only
`curl` and `tar`:

```text
<id>-server-<version>-<platform>/
  bin/<id>-server      launcher (POSIX sh)
  lib/node             Node, pinned in apps/server/scripts/tarball.ts
  lib/server.mjs       the bundled server, the same file the desktop app runs
  lib/migrations/
  lib/NODE-LICENSE
  VERSION
```

Installing by hand:

```sh
curl -LO https://github.com/<owner>/<repo>/releases/download/v1.4.2/<id>-server-1.4.2-linux-x64.tar.gz
tar -xzf <id>-server-1.4.2-linux-x64.tar.gz
<id>-server-1.4.2-linux-x64/bin/<id>-server --runner
```

The launcher follows symlinks to itself to find `lib/`, so it can be linked from `~/.local/bin`. It runs
`lib/node lib/server.mjs` with the arguments it was given, sets `NODE_NO_WARNINGS=1` unless set (node:sqlite warns
on every start), and passes the path it was started by as `brandEnv("LAUNCHER")`, which `service install` writes
into the service.

`<id>-server --version` prints the version and `--help` the commands. Other arguments are refused.

`pnpm server:package [platform...]` builds the tarballs into `apps/server/release/`: it bundles the server
(`apps/server/scripts/bundle.ts`), downloads Node from nodejs.org into `node_modules/.cache/node-runtime`, checks it
against the pinned SHA-256, and packs. The release workflow's `server` job runs it
([releases](releases.md#the-workflow)). To bump Node, change `NODE_VERSION` and the three checksums from that
release's `SHASUMS256.txt`.

### The service

A runner has to outlive the SSH session or terminal that started it, and the board that talks to it.
`<id>-server service install` makes it a background service of the user's, with no root needed:

| OS    | What it installs                                                    | Keeps running                                             |
| ----- | ------------------------------------------------------------------- | --------------------------------------------------------- |
| Linux | a systemd user unit, `~/.config/systemd/user/<id>-runner.service`   | after logout and across reboots, with linger on           |
| macOS | a launchd agent, `~/Library/LaunchAgents/<id>.runner.plist`         | while the user is logged in at the Mac's desktop; it stops at logout |

Both run the launcher with `--runner` and restart it after a crash but not after a clean stop. The service gets
`PATH` from the shell that installed it, so the runner finds `git`, `gh` and the agent CLIs, plus
`brandEnv("HOME")`, `brandEnv("PORT")` and `brandEnv("BIND")` when set. A token is never written into the service file. `status`
and a reinstall find the runner through the same variables in the shell they run in, so run them with the values
used at install (or none, for the defaults).

`install`, on Linux: writes the unit, `systemctl --user daemon-reload`, `enable`, `restart` (so a reinstall
runs the new command), then turns on linger with `loginctl enable-linger <user>` if it is off. Without linger
systemd stops a user's services when their last session ends; when the user may not turn it on, install says so
and prints the `sudo` command. On macOS it boots out any loaded agent and bootstraps the new one into
`gui/<uid>`. Either way it then waits up to 20 seconds for a runner to answer on the data dir's `server.json`
and prints its URL, or says where the log is: `journalctl --user -u <id>-runner.service` on Linux,
`<data dir>/logs/runner.log` on macOS.

Install refuses, changing nothing, when a runner started by hand already answers on the data dir (the service
would fail to start behind it, while the wait found the other one), and on a Mac where the user has no desktop
session: an SSH login alone has no `gui/<uid>` domain to load a LaunchAgent into, so log in at the Mac, or turn
on automatic login, first. If `systemctl` or `launchctl` fails, install undoes what it did: a first install
disables the unit and removes the file, a reinstall puts the previous file back and starts that service again.
`install --dry-run` prints the file and the commands without running them.

`uninstall` stops the service and removes the file; the data dir stays, and so does linger, which other
services may rely on. `status` prints the file, systemd's or launchd's state, linger, and whether a runner
answers; it exits 0 only when the service is installed and the runner answers.

Windows has no service; `service` says to run `<id>-server --runner` by hand.

### Identity

A machine is its `instanceId`: the random id in `<data dir>/instance-id` that every data dir gets on first start
(`apps/server/src/instance.ts`, also what the [backup repo](backup.md) tells machines apart by). It never changes
and nothing else identifies a runner: not its address, which moves, and not its name, which the user picks.

### The machine API

What a board says to a runner is under `/machine/`, apart from the board's own API. Schemas and paths are in
`packages/contracts/src/machines.ts`.

| Route                      | Token | What it does                                                                |
| -------------------------- | ----- | --------------------------------------------------------------------------- |
| `GET /machine/descriptor`  | no    | Who this server is. Served by a board too, to its own machine only          |
| `POST /machine/pair`       | no    | Trades a pairing code for a token                                           |
| `GET /machine/session`     | yes   | What the token is good for: the paired board, since when, and the descriptor |
| `DELETE /machine/session`  | yes   | The board unpairing itself: its token stops working                         |

```json
{
  "id": "<id>",
  "instanceId": "bf549746-2379-4a1c-98c5-6cb10f70aafb",
  "name": "engine",
  "version": "1.4.2",
  "protocolVersion": 1,
  "role": "runner",
  "capabilities": ["pairing"],
  "paired": false
}
```

`name` is the machine name from Settings (the hostname unless changed). `protocolVersion` is
`MACHINE_PROTOCOL_VERSION`: a board and a runner exchange anything beyond the descriptor and pairing only when
`machineProtocolCompatible` says so, whatever their app versions. Raise it when a change would make an older peer
misread a newer one. `capabilities` lists what the runner can do; a board drops the ones it doesn't know.

The guard treats `/machine/*` on a runner by its own rules ([architecture](../architecture.md#the-guard),
[ADR 0015](../decisions/0015-machine-api-auth.md)): no `Origin` at all, a `Host` that is an address, a local name
or a `*.ts.net` name, and a paired token on every route but the first two, which the guard checks before the route
runs. A route reads who called with `machinePairingOf(c)`. The token goes in `Authorization: Bearer` only, and opens
nothing outside `/machine/`.

### Pairing

Pairing starts on the runner, with a login there:

```text
$ <id>-server pair
Pairing code for engine: N5PA-RV5M-TS7J
It works once, within 10 minutes, and replaces any earlier code.
```

The command writes the code's hash into the runner's database (`machine_pairing_codes`), whether or not the runner
is running; there is no request that makes a code. The code is 12 symbols from an alphabet without `0 O 1 I L`,
typed in any case with or without the dashes.

The board sends it to `POST /machine/pair` with its own instance id and name, and gets a token back, once:

```json
{ "token": "<token id>.<secret>", "tokenId": "MYu8FofG2L5j", "instanceId": "bf549746-…" }
```

- The runner keeps the token's id and the SHA-256 of its secret (`machine_tokens`). The board keeps the token in
  `<data dir>/machine-tokens.json`, readable by the user only, keyed by the runner's instance id
  (`integrations/machineSecrets.ts`). It is not a setting, so it is in no backup and no response to the browser.
- A wrong, used or expired code is a 400. After ten wrong codes in a minute from one address, that address is
  refused until the minute is over.
- **One board per runner.** A runner paired with one board answers another's code with a 409 and doesn't spend the
  code. The same board pairing again (it lost its file) replaces its old token.

On the runner, `<id>-server pair list` shows the paired board, when it paired and when its token was last used, and
`<id>-server pair revoke <id>` (or `--all`, which also cancels a code not yet used) ends it at once. The `pair`
commands use the runner's data dir, so run them with the `brandEnv("HOME")` the runner has, if any.

### The board's client

`integrations/machineClient.ts` is the only code that sends a pairing code or a token to another machine. Given a
runner's instance id and one address for it, each call:

1. **Checks the address.** `https` goes anywhere. Plain `http` goes only to loopback (an SSH tunnel) or a
   Tailscale address, where the path is already encrypted; a host name is resolved and its addresses used, IPv4
   first and the next one when one doesn't answer, so what was checked is what is connected to. A LAN or public
   address over plain http is refused with nothing sent.
2. **Reads the descriptor** and stops unless it is a runner of ours with the expected instance id (`wrong-machine`)
   on a compatible protocol (`protocol-mismatch`). An answer is trusted for 30 seconds before it is asked again.
3. **Sends the request with the token.** A redirect is never followed and counts as "not a runner". A 401 means
   the runner dropped the token (`revoked`).

`pair(url, code)` does the same before sending the code, and stores the token only when the answer names the
machine the descriptor did. `MachineClientError.reason` is what callers branch on. Nothing calls the client yet
but its tests; connecting a machine from the board is the next task of the epic.

### Listening beyond loopback

A runner listens on `127.0.0.1`, which is all an SSH tunnel needs. For a board that reaches it over Tailscale,
`brandEnv("BIND")=private` makes it listen on every interface, IPv4 and IPv6 (`service install` keeps the
variable). Then:

- a connection is dropped before anything is read unless both its ends are loopback, a private range or the
  tailnet (`acceptsPeer` in `http/addresses.ts`), so a forwarded port or a public address reaches nothing;
- the machine API is all another machine can use: every other route is refused to a peer that isn't loopback,
  whatever `Host` it sends;
- `server.json` and the service still name `127.0.0.1`, so local tools and agents on the machine are unaffected.

A board refuses to start with it.

To reach a runner over `https`, put a reverse proxy in front of it that forwards **only paths under `/machine/`**.
Everything a proxy on the machine forwards arrives from loopback, so anything else it passed on would be the
runner's local API, open to whoever reaches the proxy. The guard refuses such requests when they carry a
forwarding header (`Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Real-IP`), which most proxies add, but a
proxy that adds none is not caught.

### Running a runner while developing

`pnpm sandbox --runner` starts a second server in the runner role beside the sandbox's board, on its own free
port, with its own data dir and user home under the sandbox's temp folder. The `SANDBOX_READY` line carries
`runner: {url, port, home}`, and `pnpm sandbox stop` stops it with the rest
([sandbox skill](../../.claude/skills/sandbox/SKILL.md)). To pair with it, make a code on its data dir from
`apps/server`: `<ID>_HOME=<runner.home>/data node --import tsx src/main.ts pair`. Two roles on one machine is what the later tasks of the
epic test against.

## Decisions

- **The same bundle in another role, not a second program.** Spawning agents, worktrees, session status and the
  usage readers already work in the server, so the runner gets them unchanged, and agents keep calling
  `127.0.0.1`. The cost is a runner carrying code it doesn't use, such as the board's routes.
- **A tarball with its own Node, not npm.** The desktop app's Electron can't run the server outside the app (its
  run-as-node fuse is off), and the server needs Node 24, which most servers don't have. A pinned runtime makes
  the machine need only `curl` and `tar`, at about 45 MB a platform.
- **One bundle for every platform.** The server is plain JavaScript with no native modules (`node:sqlite` is
  built in), so the tarballs differ only in the Node binary, and one Linux runner builds the macOS one too.
- **Pinned checksums.** The Node download is checked against SHA-256s in the script, not against a
  `SHASUMS256.txt` fetched alongside it, so a changed file on the mirror fails the build.
- **A user service, not a system one.** No root is needed to install, and the runner runs as the user whose
  `claude`, `gh` and git logins it needs. On Linux that needs linger; on macOS a LaunchAgent stops at logout,
  and a LaunchDaemon would need root and run outside the user's login keychain, so the stop is accepted and
  documented.
- **The launcher's own path in the service.** A service that names `<id>-server` through a stable symlink keeps
  working when the release behind the symlink changes, which updating a machine will rely on.

- **A code made on the runner, not a link made by the board.** Whoever can log in to the machine already owns it,
  so that is who may pair it; a pairing request arriving over the network proves nothing. Writing the code
  straight into the database means even a tunnel to the runner's port can't make one.
- **The instance id as identity, not a key pair.** The board needs to know it hasn't been pointed at a different
  runner (a reused tunnel port, a reassigned address), and an id answers that. Proving identity to an attacker on
  the path is the transport's job: plain http is only used where the path is already encrypted.
- **Tokens in a file, not in `settings`.** Settings are sent to the browser and written into backups; a token in
  either could be replayed against the runner by whoever read it.
- **No expiry.** A runner works unattended for weeks, and a token that expired would stop it until someone was at
  both machines. Revoking is one command.

## Alternatives considered

| Option                                   | Why not chosen                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| Publish the server to npm                | Needs Node 24 and npm on the machine, and a global install per user                  |
| A single executable (Node SEA)           | Needs a build per platform on its own runner, and `migrations/` as embedded assets   |
| Run the server from the desktop app      | Electron's run-as-node fuse is off, and a headless server has no display for Electron |
| A system-wide systemd unit               | Needs root, and runs as a user who has none of the agent logins                      |
| The shared `brandEnv("TOKEN")` for boards too | One secret for local agents and remote boards: it can't be revoked for one, and agents reading untrusted text would hold the board's way in |
| SSH tunnels only, keeping the server loopback-only | Tailscale is a route from the start, and a tunnel dies with the session that opened it |
| Mutual TLS between board and runner      | Certificates to issue, renew and trust on machines nobody administers; the transports in use already encrypt |
| Binding to the Tailscale address only    | It doesn't exist until Tailscale is up, so a runner started at boot would fail; the peer filter gives the same reach |
| One limit on wrong pairing codes for everyone | Any machine that could reach the runner could keep pairing refused by sending wrong codes |

## Code map

| File                                    | What it does                                                         |
| --------------------------------------- | -------------------------------------------------------------------- |
| `apps/server/src/main.ts`               | Arguments: `--runner`, `--version`, `--help`, `service …`, `pair …`   |
| `apps/server/src/config.ts`             | `role`, from `--runner` or `brandEnv("ROLE")`; a runner has no `webDist`; `bind` |
| `apps/server/src/app.ts`                | `/api/health` with the role                                           |
| `apps/server/src/service/cli.ts`        | `service install`, `uninstall`, `status`                              |
| `packages/contracts/src/machines.ts`    | The machine API's schemas, paths and `MACHINE_PROTOCOL_VERSION`       |
| `apps/server/src/http/routes/machine.ts` | The descriptor, the pairing exchange and the session                 |
| `apps/server/src/http/guard.ts`         | The machine API's rules and the peer check                            |
| `apps/server/src/http/addresses.ts`     | Loopback, tailnet, private or public; which connections a runner serves |
| `apps/server/src/services/machineAuth.ts` | Pairing codes and tokens on the runner                              |
| `apps/server/src/pairCli.ts`            | `pair`, `pair list`, `pair revoke`                                    |
| `apps/server/src/integrations/machineClient.ts` | The board's client: address rule, id and protocol checks, no redirects |
| `apps/server/src/integrations/machineSecrets.ts` | The board's tokens file                                       |
| `apps/server/src/service/definitions.ts` | The systemd unit and launchd plist                                   |
| `apps/server/scripts/bundle.ts`         | The bundle, then the tarballs with `--tarballs`                       |
| `apps/server/scripts/tarball.ts`        | The pinned Node, the launcher, the tarballs and their checksums       |
| `apps/server/scripts/sandbox.ts`        | `--runner`                                                            |
| `.github/workflows/release.yml`         | The `server` job                                                      |
