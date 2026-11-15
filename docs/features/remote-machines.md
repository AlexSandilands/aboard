# Remote machines

Board tasks: #179, #180, #181, in epic #178 (run tasks on another machine).

A task can be set to run on another machine: a server or a second computer the board connects to. That machine
runs the same server as the board, started in the **runner** role: it serves no board or web app, holds the
tasks sent to it, and runs their agents. This page covers the part that exists so far: the runner role, the
release and the script that put the server on a machine with nothing installed, the background service that keeps
it running, how a board and a runner come to trust each other (identity, pairing, tokens and the machine API), and
how a board connects a machine: installing over SSH, routes, status, logins and updates. All of that is the
server's so far: the Settings page that drives it, held tasks and remote runs aren't built yet; they are the later
work of epic #178.

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

`pnpm server:package [platform...]` builds the tarballs into `apps/server/release/`, with `install-runner.sh` for
that version beside them: it bundles the server
(`apps/server/scripts/bundle.ts`), downloads Node from nodejs.org into `node_modules/.cache/node-runtime`, checks it
against the pinned SHA-256, and packs. The release workflow's `server` job runs it
([releases](releases.md#the-workflow)). To bump Node, change `NODE_VERSION` and the three checksums from that
release's `SHASUMS256.txt`.

### Installing a runner

`install-runner.sh` puts a runner on a machine and prints a pairing code. Each release carries its own, written by
`runnerInstallScript(version)` (`packages/contracts/src/runnerInstall.ts`), so the names in it come from the brand
and the version from the release. Run by hand:

```sh
curl -fsSL https://github.com/<owner>/<repo>/releases/download/v1.4.2/install-runner.sh | sh
curl -fsSL …/install-runner.sh | sh -s -- --tailscale   # also reachable at the machine's Tailscale address
```

What it does, on Linux x64 or arm64 and macOS arm64, needing `curl` and `tar`:

1. Takes the `PATH` of the user's login shell (`$SHELL -lic`). A command run over SSH gets a bare one, and the
   service keeps the `PATH` it is installed with, which is where `claude`, `codex` and `gh` are found.
2. Downloads the tarball for the machine's platform and `SHA256SUMS-server.txt` from the release, and stops unless
   the tarball's SHA-256 is the one listed. A release already unpacked is not downloaded again.
3. Unpacks it and links it:

   ```text
   ~/.local/share/<id>-server/
     releases/<id>-server-<version>-<platform>/
     current -> releases/<id>-server-<version>-<platform>
   ~/.local/bin/<id>-server -> ~/.local/share/<id>-server/current/bin/<id>-server
   ```

   The service runs `~/.local/bin/<id>-server`, so an update only repoints `current`.

4. Runs `<id>-server service install`, with `brandEnv("BIND")=private` for `--tailscale` and `brandEnv("PORT")` for
   `--port`.
5. Runs `<id>-server pair` and says what to type into the board.

Other options: `--version <v>`, `--base-url <url>` (the release files somewhere else, `file://` included) and
`--porcelain`, which the board's SSH install uses: the script then prints `@@step <name>` as it starts each step and
ends with `@@pair ` and the JSON of `<id>-server pair --json` (the code, the runner's port, instance id and name, and
its Tailscale address when `--tailscale` found one). Nothing in the script reads stdin, so it can be piped into `sh`.
Running it again installs over what is there, which is also how a runner is updated by hand.

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
| `GET /machine/status`      | yes   | Version, platform, runs in flight, logins, and where an update is ([below](#status-and-logins)) |
| `POST /machine/update`     | yes   | The board asking the runner to update to a version ([below](#updates))      |

```json
{
  "id": "<id>",
  "instanceId": "bf549746-2379-4a1c-98c5-6cb10f70aafb",
  "name": "engine",
  "version": "1.4.2",
  "protocolVersion": 1,
  "role": "runner",
  "capabilities": ["pairing", "status", "update"],
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
`<id>-server pair revoke <id>` (or `--all`, which also cancels a code not yet used) ends it at once. `pair --json` makes a code and prints it as
one line of JSON with the runner's port, instance id and name, for the install script. The `pair`
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
machine the descriptor did. `MachineClientError.reason` is what callers branch on. `request` takes
`{ anyProtocol: true }` to skip the protocol check, which only the update request uses.

### Connecting a machine

A board keeps the machines it is connected to in the `machines` table (`services/machines.ts`): the runner's
instance id, a name, a prefix, its routes in order, and what it last said of itself (version, protocol version,
platform, logins, when). The table is in no backup: which machines a board reaches, and how, belongs to the machine
the board runs on. How each is reached right now is not stored; `integrations/machines/` holds it in memory and
`GET /api/machines` returns both together.

There are two ways in, and they end in the same paired state:

- **Over SSH** (`POST /api/machines {via: "ssh", target}`): the board pipes the install script to
  `ssh <target> sh -s -- --porcelain --version <its own version>`, opens a tunnel to the port the script reports,
  pairs through it with the code and the instance id the script printed, stores the machine with the SSH route,
  and connects. With `tailscale: true` the script is passed `--tailscale` and the address it reports becomes a second
  route. The answer is an install (`MachineInstall`: six steps, each pending, running, done or failed, with the end
  of what the remote printed); it stays in `GET /api/machines`' `installs` until dismissed
  (`DELETE /api/machines/installs/:id`). The line with the pairing code never reaches that log.
- **By a pairing code** (`POST /api/machines {via: "code", url, code}`): for a machine the board can't SSH to. The
  user runs the install script there with `--tailscale` and gives the board the address and code it prints. The
  board pairs at that address, which becomes the machine's route.

`ssh` is the user's own, with their config, keys and agent. It runs with `BatchMode=yes`, so a login that needs a
password or passphrase typed fails, and an unknown host key is not accepted: the user runs `ssh <target>` once
themselves. `sshFailure` turns what ssh printed into a sentence saying which of those it was. The target is
validated (`SshTarget`) and passed after `--`, so it can't be read as an option.

Connecting a machine the board already knows (a reinstall, a new code) keeps it one machine with its name and
prefix, and puts the route just used first.

**The prefix** is one to three capitals or digits starting with a letter, suggested from the name (`engine` → `E`,
then `EN`, …) and unique among the board's machines. Tasks made on the machine while the board can't be reached
will be numbered with it, so once one is (`machines.fixPrefix`, called by the later task that numbers them) it
can't change. Until then `PATCH /api/machines/:id` changes it, the name and the routes.

`DELETE /api/machines/:id` tells the runner to drop the board's token when it can be reached, forgets the token and
the machine, and leaves the runner installed: `<id>-server service uninstall` on the machine removes it.

A board run from source has version `0.0.0`, which no release carries, so it refuses an SSH install and asks for no
updates, unless `brandEnv("RELEASE_URL")` names a folder or server holding the release files (what
`pnpm server:package` writes into `apps/server/release/`).

### Routes

A machine has an ordered list of routes (`MachineRoute`), the first being the one preferred:

| Kind     | What it is                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------- |
| `ssh`    | `ssh -N -L 127.0.0.1:<free port>:127.0.0.1:<runner port> <target>`: the runner stays on its own loopback and the board reaches it at a loopback port of its own |
| `direct` | The runner's own URL: its Tailscale address or name over http, or an https URL                      |

`integrations/machines/link.ts` is one machine's connection:

- Routes are tried in order, and the first that answers **as the expected instance** is used. A route that
  answers as another machine fails like one that doesn't answer.
- A route that fails waits before its next try: 2s, 4s, 8s, doubling up to 5 minutes.
- Every 30 seconds the route in use is checked, and every better route whose wait is over is tried again. When
  one works the link moves back to it and closes the other.
- A tunnel whose `ssh` exits is replaced at once, starting from the first route.
- `POST /api/machines/:id/check` tries every route now, whatever their waits.

What a machine's `connection` says:

| Connection     | Meaning                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------- |
| `connected`    | Reachable, paired and on the board's protocol version                                         |
| `connecting`   | No route has been tried yet                                                                   |
| `unreachable`  | No route works now; they keep being retried. `error` is the first route's reason              |
| `needs-update` | Reachable, on another protocol version ([below](#updates))                                    |
| `unpaired`     | Reachable, but it no longer accepts the board's token. `POST /api/machines/:id/pair {code}` pairs again |

`routeStates` has each route's own state (`active`, `standby`, `connecting`, `failed` with its error and next try).
`integrations.machines.request(id, path)` is how the rest of the server talks to a machine: over the route in use,
and only while it is `connected`.

### Status and logins

While a machine is connected the board reads `GET /machine/status` on every check and keeps the answer:

```json
{
  "version": "1.4.2",
  "platform": "linux-x64",
  "runsInFlight": 0,
  "logins": [
    { "name": "claude", "state": "ok", "detail": null },
    { "name": "codex", "state": "missing", "detail": "`codex` isn't on the runner's PATH." },
    { "name": "gh", "state": "ok", "detail": null },
    { "name": "git", "state": "logged-out", "detail": "git has no way to push to GitHub. Run `gh auth setup-git` on the machine, or add an SSH key to GitHub." }
  ],
  "update": { "state": "idle", "targetVersion": null, "error": null },
  "selfUpdate": true
}
```

A runner needs its own logins; the board only reports what is missing. `integrations/machines/logins.ts` checks
them on the runner, with the service's `PATH`, at most once a minute:

| Login    | How it is checked                                                                               |
| -------- | ----------------------------------------------------------------------------------------------- |
| `claude` | `claude auth status` exits 0                                                                    |
| `codex`  | `codex login status` exits 0                                                                    |
| `gh`     | `gh auth status` exits 0                                                                        |
| `git`    | git has a credential helper (gh's counts only while gh is logged in), or `ssh -T git@github.com` is greeted |

Each is `ok`, `logged-out`, `missing` (not on the `PATH`) or `unknown` (the check didn't finish), with a sentence
saying what to run. The git check is about GitHub only, where the board's pull requests are.

### Updates

The board decides the version; a runner never updates by itself. After each check, a board whose own version is
newer than the machine's sends `POST /machine/update {"version": "<the board's>", "now": false}`, and the runner
(`integrations/machines/selfUpdate.ts`):

1. waits while it has runs in flight, looking every 15 seconds (`waiting`). `"now": true`, from
   `POST /api/machines/:id/update {"now": true}`, doesn't wait: the restart ends those runs;
2. downloads the tarball for its own platform and the checksums from that version's release, and checks the
   SHA-256 (`downloading`). The URL is built on the runner from the version; the request can't name one;
3. unpacks it beside the running release and runs its launcher with `--version`, which must print the version
   asked for;
4. moves `current` over to it in one rename, deletes releases older than the one it is leaving, and exits with
   code 75 (`restarting`). systemd (`Restart=on-failure`) and launchd (`KeepAlive` on a failed exit) start the
   runner again, now through `current` on the new release.

A failure anywhere before step 4 leaves the running version as it was and reports `failed` with the reason. The
board doesn't ask again by itself after a failure; `POST /api/machines/:id/update` does. The answer to the request
and `GET /machine/status` both carry where the update is (`MachineUpdateState`).

Only a runner the install script installed, running as its service, can do this: the script's layout is what gives
it a `current` to repoint, and `brandEnv("SERVICE")=1`, which `service install` sets, is how it knows something
will start it again. Any other answers 409, and its machine shows `selfUpdate: false`.

A machine **newer** than the board is left alone (`versionState: "newer"`): going back would run old code on a
database the newer version has migrated. The board is the one to update.

**Protocol mismatch.** A machine whose `protocolVersion` the board can't talk to (`machineProtocolCompatible`)
keeps its route and gets the connection `needs-update`. Nothing is exchanged with it: its status isn't read and
`machines.request` refuses. The runner carries on by itself. The one request still sent is the update, which is
how the mismatch ends, so **`UpdateMachineRequest` and `MachineUpdateState` must stay readable by every version**:
add optional fields, never change or remove one.

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

- **One script for both ways of installing.** The board's SSH install pipes the script the release publishes, so
  the path a user takes by hand and the one the board takes can't drift apart, and there is one layout to update.
- **The script is generated, not a file in the repo.** It needs the product's name, its env var prefix and the
  release URL, none of which may be hard-coded; `packaging/install-arch.sh` is a file and has a test holding its
  copies to `package.json` instead.
- **ssh never trusts a new host key for the user.** `StrictHostKeyChecking=accept-new` would make the first
  install to a new machine work with no step by hand, and would also accept whatever answered at that name. The
  board is about to send that machine a pairing code and run agents on it.
- **Route state in memory, not in the table.** It changes every few seconds and means nothing after a restart.
- **The runner exits to update; it doesn't restart its own service.** A failed exit code is what both service
  managers already restart on, so there is no `systemctl` or `launchctl` call to get wrong from inside the service
  being restarted.
- **The runner checks the download against the release's own checksums.** They come from the same place as the
  tarball, so this catches a broken download, not a compromised release; nothing the board could send would be
  from anywhere else.
- **No downgrades.** Migrations only go forward.

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
| Copying the tarball from the board over SSH | The board would need every platform's tarball, 45 MB each; the machine has to reach GitHub for updates anyway |
| The board sends the checksum with the update request | The board would have to fetch the checksums for the runner's platform first, and it adds no trust: same source |
| Rolling back when the new release fails to start | Needs a launcher that outlives the server and a database snapshot, as T3 Code's has; the previous release stays on disk for now |
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
| `packages/contracts/src/runnerInstall.ts` | The release's file names and URL, and the install script            |
| `apps/server/src/services/machines.ts`  | The machines a board is connected to, as stored; prefixes            |
| `apps/server/src/integrations/machines/index.ts` | Connecting, the install job, one link per machine, status and update requests |
| `apps/server/src/integrations/machines/bootstrap.ts` | The install over SSH and what it prints                  |
| `apps/server/src/integrations/machines/ssh.ts`, `tunnel.ts` | `ssh`'s arguments and failures; opening a route   |
| `apps/server/src/integrations/machines/link.ts` | Route order, waits and moving back                           |
| `apps/server/src/integrations/machines/logins.ts` | The runner's login checks                                  |
| `apps/server/src/integrations/machines/selfUpdate.ts` | The runner updating itself                             |
| `apps/server/src/http/routes/machines.ts` | `/api/machines`                                                    |
| `apps/server/scripts/bundle.ts`         | The bundle, then the tarballs with `--tarballs`                       |
| `apps/server/scripts/tarball.ts`        | The pinned Node, the launcher, the tarballs and their checksums       |
| `apps/server/scripts/sandbox.ts`        | `--runner`                                                            |
| `.github/workflows/release.yml`         | The `server` job                                                      |
