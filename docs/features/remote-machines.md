# Remote machines

Board tasks: #179, #180, #181, #12, #182, in epic #178 (run tasks on another machine).

A task can be set to run on another machine: a server or a second computer the board connects to. That machine
runs the same server as the board, started in the **runner** role: it serves no board or web app, holds the
tasks sent to it, and runs their agents. This page covers what exists so far: the runner role, the release and the
script that put the server on a machine with nothing installed, the background service that keeps it running, how
a board and a runner come to trust each other (identity, pairing, tokens and the machine API), how a board
connects a machine (installing over SSH, routes, status, logins, updates and the Settings page that drives them),
and [held tasks](#held-tasks): handing a task to a machine, the change log the machine keeps and the board
replays, the board's own edits to a held task, the numbers a machine gives the tasks it makes, and
[work on the machine](#work-on-the-machine): the headless runs, review rounds and scripts of a held task, and how
the board shows the sessions and tokens of work it can't see.

Not built yet: choosing a machine for a task in the UI (a hand-over is an API call, `POST /api/tasks/:id/hold`),
Autopilot's engine running on the machine by itself (a board starts every run), and T3 Code threads or terminals
on the machine. An image attached on the machine isn't sent to the board. Nor are notifications: what an agent on a
machine does to a held task changes the card (its request for attention shows as a flag) but raises no inbox entry
or pop-up on the board. Those are the later tasks of epic #178. What a user does is in the
[guide](../guide/remote-machines.md).

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
`--porcelain`, which the board's SSH install uses (reading stdout and stderr apart, so a warning the remote prints
can't land inside one of these lines or carry the code into the install's log): the script then prints `@@step <name>` as it starts each step and
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
| `POST /machine/tasks`      | yes   | The board handing a task over ([held tasks](#held-tasks))                   |
| `DELETE /machine/tasks/:id` | yes  | The board taking a task back                                                |
| `GET /machine/changes`     | yes   | The board's poll: the log entries it hasn't applied, and what the runner asks of it |
| `POST /machine/edits`      | yes   | An edit made on the board to a task the runner holds                        |
| `POST /machine/replies`    | yes   | The board's answer to something the runner asked                            |
| `POST /machine/jobs`       | yes   | The board starting work on a held task: a run, a command, a script ([below](#work-on-the-machine)) |
| `GET /machine/jobs/:id`    | yes   | The board reading a job until it ends; `DELETE` once it has the outcome      |
| `PUT /machine/settings`    | yes   | The board's settings the machine works by                                   |
| `POST /machine/transcript` | yes   | A page of the transcript of a session that ran on the machine               |
| `PUT /machine/attachments/:id` | yes | One of a held task's pasted images                                        |

```json
{
  "id": "<id>",
  "instanceId": "bf549746-2379-4a1c-98c5-6cb10f70aafb",
  "name": "engine",
  "version": "1.4.2",
  "protocolVersion": 1,
  "role": "runner",
  "capabilities": ["pairing", "status", "update", "tasks", "runs"],
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
prefix, and puts the route just used first. A prefix asked for that another machine holds is refused before
anything is installed or a code is spent; one taken while an install ran is replaced by a suggested one, since the
machine is paired by then. If storing a newly paired machine fails, its token is dropped again.

**The prefix** is one to three capitals or digits starting with a letter, suggested from the name (`engine` → `E`,
then `EN`, …) and unique among the board's machines. Tasks made on the machine while the board can't be reached
will be numbered with it, so once one is (`machines.fixPrefix`, called by the later task that numbers them) it
can't change. Until then `PATCH /api/machines/:id` changes it, the name and the routes.

`DELETE /api/machines/:id` tells the runner to drop the board's token when it can be reached, forgets the token and
the machine, and leaves the runner installed: `<id>-server service uninstall` on the machine removes it.

A board run from source has version `0.0.0`, which no release carries, so it refuses an SSH install and asks for no
updates, unless `brandEnv("RELEASE_URL")` names a folder or server holding the release files (what
`pnpm server:package` writes into `apps/server/release/`); the install command the board shows then downloads from
there and passes `--base-url`. With no release at all, the add dialog shows `<id>-server pair` in place of an
install command that would 404.

### The Machines page

Settings → Integrations → Machines (`components/settings/machines/`) is `GET /api/machines` drawn as one card: a row
per install that hasn't finished, then a row per machine. The list is refetched on `machines.changed`, which the
server publishes on every change to a machine, its link or an install, so nothing on the page polls.

- **A machine's row** is one line (`machineSummary`): a dot for its connection, name, prefix, the route in use and
  runs in flight, then a badge for anything wrong (logins missing, an update waiting, running or failed) and its
  version. It opens to a callout for a machine that isn't connected, then Version, Logins, Routes, and Name and
  prefix with Remove.
- **A row opens by itself** when the machine needs the user: unreachable, needs updating, unpaired, a login
  missing or an update that failed. Once the user opens or closes a row, that choice holds until the page is left.
- **Each callout carries its one action**: Try now (`/check`) for unreachable, a code field and Pair (`/pair`) for
  unpaired. Needs updating has none: the update is under Version.
- **Routes** are reordered with arrows, removed, and added as an address; every change saves the whole list
  (`PATCH`), which restarts the machine's link. A failed route shows its reason and when it is tried next, counted
  from when the list was read.
- **Add machine** is a dialog with two tabs, one per way in. Over SSH closes as soon as the install has started,
  and the install carries on as a row; a failed one has Try again, which reopens the dialog with the destination
  filled in, and Dismiss. On a board with no release to install, the SSH tab says so and its button is off.
- **Remove** asks in place, and says the runner stays installed and how to remove it.

The server's sentences are shown as they are (`error`, a login's `detail`, an install's `error`), so what the
user is told to do is written once, where the cause is known.

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
saying what to run. The git check is about GitHub only, where the board's pull requests are. The checks start
programs and one may reach for the network, so the status waits at most 4 seconds for them and otherwise answers
with what was last known (`unknown` the first time); the check carries on for the next read.

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
database the newer version has migrated. The board is the one to update. Every way in holds to it: the install
script stops, before it downloads anything, when the runner already on the machine is newer than the version asked
for (so a reinstall over SSH, or the script run by hand with an older `--version`, can't do it either); the board's
`POST /api/machines/:id/update` answers 409 for a newer machine, and a runner answers 409 to a version older than
its own.

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

### Held tasks

The board owns every task. Handing one to a machine gives that machine a **working copy** and makes it the one
place where changes to the task are ordered: an agent there changes the copy, the runner records each change in a
log, and the board applies the log. While a machine holds a task, the board's `task_holds` row says so, and the
task's summary carries `hold: {machineId, machineName, since, waiting}`, which the card and the panel show as
`On <machine>` (the panel's chip and the card's number, [below](#choosing-the-machine)).

```text
 board                                          runner
 POST /api/tasks/:id/hold ──POST /machine/tasks──► working copy (the task's own rows, the board's ids)
                                                        │ an agent's tool call, or an edit the board sent
                                                        ▼
 services/holds.apply ◄──GET /machine/changes── change_log: one entry per write, in order
        │ one write, events published                   ▲
        ▼                                               │
 browsers (SSE)          edit on the board ──POST /machine/edits──┘
```

A hand-over (`integrations/machines/sync.ts` `handOver`) sends the task's identity (id, number, kind, who made
it), its state, its last 50 activity entries (so an agent on the machine reads the same handover notes), its
project, and the tasks it points at. The runner stores it in its ordinary tables under the board's ids
(`services/workingCopies.ts` `accept`), so every service and tool works on it as on a board; `working_copies`
says which task rows are held. The board records the hold only after the runner has answered, and refuses when the
task is no longer as it was sent (its whole state is compared: a link added meanwhile doesn't stamp the task). An epic, a manual task and an archived task can't be handed over.

**What the copy carries**, and so what the machine orders: title, description, plan context, status, resolution,
the flags (Autopilot, auto-merge, auto-review, reviewer model, priority, manual), due date, an agent's request for
attention, the suggested model, labels, the plan, its review rounds with their findings, links (without what a
poller read of them: each side polls for itself, except a session that ran on the machine, whose status is the
machine's to read) and the tasks blocking it. **What stays the board's**: the task's project, its epic, its place in the lane,
archiving and deleting. A held task can't be archived (by itself, with its epic, or by Autopilot's Auto-archive),
deleted, moved to another project or made an epic, and its project can't be archived or deleted, until it is taken
back; its epic and its place in the lane change on the
board without the machine hearing of it. Pasted images are sent beside the copy
([below](#images)); token usage travels with the log's entries, not in the state.

**Tasks it points at.** A held task's epic, its blockers, the tasks it blocks and the one it was closed against
come along as **references**: task rows on the runner with the number, title, status and (for an epic) the
delivery and integration branch, marked `reference` in `working_copies`. They are there so the held task reads
right (`Delivery: start from epic/…`, `Blocked by #41`), are left out of the runner's lists, and can't be changed
there. They are as the board had them at hand-over, or at the last edit that named them; an epic's status on a
runner is the board's word, never derived from the few tasks held there. A reference no held task points at any
more is dropped.

### The change log

On a runner, every write that touches a held task appends one entry to `change_log` before it commits
(`core.beforeCommit`, `services/workingCopies.ts` `logChanges`), so a change and its entry are one transaction. An
entry is **the task's whole state after the change**, plus the activity entries the change wrote:

| Kind       | When                                           | Carries                                                    |
| ---------- | ---------------------------------------------- | ---------------------------------------------------------- |
| `state`    | A held task changed                            | The state, the new activity, and what its sessions and runs there have used |
| `created`  | A task was made on the runner                  | Its identity, project and references too; it is held at once |
| `released` | The board took the task back                   | The last state; the runner drops its copy with this entry  |

A write that changed nothing logs nothing (the state last logged is kept beside the copy). Entry ids are the
runner's own counter. `epoch` names the log: a random id made with the runner's database, so a board can tell a
runner whose database was replaced, whose ids start again.

### The log's format

Every entry carries the format it was written in (`CHANGE_LOG_FORMAT`, `packages/contracts/src/workingCopies.ts`).
A runner can hold days of entries while the board updates itself, so **a board reads every format ever written**:

- Raising `CHANGE_LOG_FORMAT` needs a function in `CHANGE_LOG_UPGRADERS` that turns the format before into the new
  one, and a new entry in `packages/contracts/src/fixtures/changeLogFormats.ts` with entries as the new format
  stores them. `readChangeLogEntry` runs the upgraders in a chain.
- A fixture is never edited or removed, and an upgrader is never removed. `workingCopies.test.ts` fails when a
  format has no fixture or no upgrader, and reads every fixture as the current format.
- A field added without raising the format must be optional: unknown fields are dropped when read.
- The other way round (a runner updated before its board) is refused, not guessed at: replay stops at the first
  entry in a format newer than the board knows, keeps its position, and carries on once the board is updated.

### Replay

The board reads each machine's log with `GET /machine/changes?after=<last id applied>&wait=<ms>`
(`integrations/machines/sync.ts`). The runner holds the request open up to `wait` (8 seconds) while it has nothing
to say, and answers the moment the log grows, so a change is on the board within that request. The same read is
the catch-up: after the board was off, or the link was down, it asks from where it stopped and gets everything
since, 200 entries at a time. The loop runs for every connected machine whether or not the pollers do.

`services/holds.ts` `apply` takes one answer in one write:

- Entries are applied in id order. Each writes the state over the board's rows (`services/taskState.ts`), appends
  the activity as it was logged there (its time and actor), moves the card to the end of its new lane when the
  status changed, re-derives the task's epic, and marks the task changed, so browsers get the same `task.upserted`
  a local change sends ([live sync](live-sync.md)). The board doesn't re-run the rules: the runner ran the same
  code when it made the change.
- **An entry is applied once.** The position (`machine_sync.applied_log_id`) is written in the same transaction
  as the entries, and an entry at or before it is skipped. So an answer that arrives twice, or a read repeated
  after the connection dropped halfway, changes nothing. A state is also the same whichever way it is written, so
  an entry applied twice would leave the task as it was.
- The runner drops entries from its log once the board asks for what comes after them.
- A `created` entry makes the board's task under the runner's id and number, held by that machine. Its project is
  the board's by id, else by repository ([below](#projects-on-a-machine)), else General.
- An answer from another `epoch` starts again from the beginning, and gives back the tasks the runner no longer
  lists as held (`released`, `lost: true`).
- An entry for a task the board doesn't have that machine holding is skipped: it was taken back by force. So is
  an entry from before the hold began (`task_holds.after_log_id`, the log's head when the machine took the task),
  which a task taken back by force and handed to the same machine again would otherwise bring back.
- Once the board has read the whole log, and only then, a task the runner lists as held that the board didn't hand
  it is one to drop, and the runner is told to. Before that the task may be one made on the machine whose `created`
  entry is still to come.
- An entry the board can't read stops replay there. The loop then waits as for a machine it can't reach (2 seconds,
  doubling to 30) before asking again, and says so in the log once.

### Edits from the board

Whoever changes a held task on the board (the web app, an agent over MCP, a poller finishing a merged PR) goes
through the service layer, and `services/heldEdits.ts` wraps the methods that change a task. For a held task the
wrapper, in one write:

1. applies the edit on the board, so the card shows it at once;
2. queues it in `held_edits`: the method's name, its arguments, the ids it gave what it made (a step, a link), and
   the activity entries it wrote.

`hold.waiting` counts the queued edits the machine hasn't answered, and the panel's chip reads `On engine · 2 waiting`.
`hold.waitingSteps` (the steps an `updateStep` or `moveStep` edit names) and `hold.waitingEvents` (the activity those
edits wrote here) let the panel mark them: a clock beside the step, and "waiting for engine" in place of the
entry's age.
The edits are sent in order (`POST /machine/edits`), straight away while the machine is connected, and before the
next read of its log otherwise. The runner runs the same method with the same arguments, handing out the same ids
(`core.withIds`), so an edit made later on the board can point at a step an earlier one added. Its outcome is a
log entry like any other, and when the board applies it the queued edit goes, with the activity the board wrote
for it: the machine's entries are the ones kept.

The machine's order wins. What an agent did while the link was down is already in its log, so the board's edits
land after it. An edit the runner refuses as the task stands there (the step it checks off was deleted) is taken
back: the board logs `edit_refused` with the reason, and the runner logs the state all the same, which puts the
card back. One sent twice is applied once (`applied_edits`). A runner gives its verdict even on an edit it can't
read (a newer board's kind of edit), logging the state the same way; an answer that is no verdict at all leaves the
edit queued when the runner failed (a 5xx) and refuses it otherwise.

What is the board's alone isn't sent: a card's place in its lane, and its epic.

The methods passed on are the ones that change a task, its plan, its links, a request for attention and its review
rounds (`reviews.openRound`, `submit`, `resolveFinding`): Run review or a finding resolved on the board happens on
the machine, under the ids the board gave.

### Choosing the machine

Where a task runs is a property of the task (`packages/contracts/src/runOn.ts`): its own `runOn` (a connected
machine's id, `here`, or null to follow its project), then its project's `runOn` (a machine's id, or null for this
machine), then this machine. A machine the board no longer has counts as no choice. The server reads it in one place,
`services/runOn.ts` `taskRunsOn`; the web app with `resolveRunOn` too (`components/task/runOn.logic.ts`).

- **Setting it.** `PUT /api/tasks/:id/run-on {runOn}` (`tasks.setRunOn`, which logs `run_on`) and
  `PATCH /api/projects/:id {runOn}`. Only the user sets it: no MCP tool does. An epic, a manual or archived task has
  none, and an unknown machine is refused.
- **Locked once started.** A task that left Backlog and Planned, or that a machine holds, keeps where it is (CONFLICT):
  one that started here stays here, and one held stays held until it is pulled back.
- **Handing over at start.** The board's runner is wrapped (`integrations/machines/startOn.ts` `handOverAtStart`):
  a Start planned run of a task that resolves to a machine and isn't held hands it over first, as `autopilot`, and the
  run then goes to the machine like every run of a held task. A hand-over that fails (the machine can't be reached,
  can't clone the repository) fails the run with that reason; nothing starts here instead. Start planned is the one way
  a task starts on a machine for now: a thread or session from the hand-off window runs on this machine, so the window
  refuses one that would start the work of a task that runs elsewhere. Planning it there is allowed (the task stays in
  Backlog or Planned), and a task a machine holds gets no thread or session here at all.
- **What the board shows.** The task panel's chip beside Status picks the machine before the task starts ("Run on
  engine", a menu of the project's default, this machine and each machine with how it is) and, once held, is the hold
  ("On engine", "On engine · 2 waiting", "engine · offline") with Pull back in its popover. The hand-off window has the
  same choice in the strip under the composer, and it saves onto the task. A card's number carries the machine's
  prefix (`E182`): outlined for a task that will start there, tinted while held, with an amber dot while edits wait,
  greyed and struck through while the machine can't be reached. Project settings › General has Runs on. All of it
  shows only once a machine is connected and the project has a folder.
- **A machine that can't be reached** greys the chip and the card's prefix, and the panel says since when, with Try
  now (`POST /api/machines/:id/check`). It is not an attention flag: the agent there carries on.
- **What agents see.** `get_task` says `Machine: engine (…)` for a task that will start on one, and `Held by: engine
  (…)` once it has, and that only the user changes it.

A task-less scheduled automation's own machine pin is #184's, with Autopilot on the machine: a job today needs a held
task.

### Pulling a task back

`POST /api/tasks/:id/pull-back {force?}` (`machineSync.pullBack`) is the user's way to bring a started task here. It is
refused (CONFLICT, naming the automation) while a run for the task is queued or going, so there is no agent on the
machine to stop; runs push their own branch. Otherwise it takes the task back as below (with `force` for a machine that
can't be reached, which the panel offers only then), sets the task to `here`, and fetches `origin` in the board's
checkout so the branch the machine pushed is here. A fetch that fails is logged, not fatal.

### Taking a task back

`DELETE /api/tasks/:id/hold` sends the edits still waiting, then asks the runner to release. The runner appends
`released` with the last state, turns its copy into a reference (or drops it, when no held task points at it), and
the board ends the hold when it applies that entry, after everything before it. With `{"force": true}` the board
doesn't wait: the hold ends at once, the queued edits stay as the task's state, and whatever the machine changed
since it was last read is lost; the machine drops its copy when it is next reached. Removing a machine takes back
its tasks by force. A held task is in the `busyTaskIds` its board publishes with its backup, so another board
won't [move it](backup.md#moving-tasks-between-machines).

### Projects on a machine

A project is the repository its `origin` names, never a path: the board's folder means nothing on the machine. A
hand-over carries the project's id, title, `origin` URL and `host/owner/repo`. The runner looks its own project
up by the board's id, then by repository (`copied_projects`); when it has none it clones the URL into
`<data dir>/repos/<host-owner-repo>` (`integrations/machines/checkouts.ts`) with the machine's own git credentials,
and makes its project there. The URL has to name a repository on a host over https, ssh or git (nothing git would
take for an option or a command), and the folder's name comes from the URL itself. A clone that fails refuses the hand-over with git's reason ("engine can't clone
git@github.com:acme/app.git: fatal: Could not read from remote repository."), and nothing is handed over. A
project with no repository becomes a project with no folder. A task made on the runner names its project the same
way, which is how the board finds its own.

### Work on the machine

A task a machine holds is worked on there. The board decides what runs (its Autopilot engine, its automations, its
settings); the machine does it, with the code a board runs locally.

```text
 board                                                    runner
 engine: a run for a held task
   └─ remoteWork.runner ──POST /machine/jobs {run}──► jobs: started in the background
        │ ◄──GET /machine/jobs/:id?after&wait── updates (session, worktree, model), then the result
        ▼
   the board's run row                                createAutopilotRunner: worktree, push guard, run tokens, CLI
```

**Jobs.** `POST /machine/jobs` takes `{id, kind, taskId, params}` and answers at once; the work goes on in the
background (`integrations/machines/jobs.ts`). The board reads `GET /machine/jobs/:id?after=<seq>&wait=<ms>`, held
open up to 8 seconds while nothing is new, until the job is `done` or `failed`, then deletes it. The same id sent
twice starts one job. Jobs are in memory:

- A runner that restarted answers `unknown`, and the board fails the run with "<machine> restarted while this was
  going". That is today's behaviour for a board's own restart; there is still no cancel.
- A machine the board can't reach is asked again (2 seconds, doubling to 30) until it has been silent for 15
  minutes (5 for a command or a script), counted from its last answer and not from when the job began: a link that
  drops late in a long run costs nothing. The job goes on there meanwhile, and what the agent does to the task
  arrives through the log either way. The run's own timeout is kept on the machine, which stops the agent.
- A board that restarts mid-run fails its run as it does a local one, and flags it: the job on the machine finishes
  unobserved. A Review PRs or Fix PRs run, which a board otherwise redoes after a restart, is not redone for a held
  task, since a second agent would work on the same branch beside the first.
- A machine that never said it can do this (no `runs` among its capabilities: a runner from before it) is refused
  before anything is sent, with "update it first". The board's own review watchdog keeps looking after such a
  machine's tasks.

| Kind     | What runs                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------- |
| `run`    | A headless agent run: the `RunnerRequest` the board's runner would have taken                      |
| `shell`  | A custom automation's command, in the machine's clone of the project                               |
| `script` | A custom automation's script, the same way                                                         |

**Runs.** The board's runner is wrapped (`remoteWork.runner`): a request whose task is held goes to its machine,
anything else (a task the board holds, a run with no task, a nudge into a T3 thread) runs here. On the machine
`runnerWork` hands it to the same `createAutopilotRunner`, so the worktree is under the runner's data dir
(`<data dir>/worktrees`), with the push guard and, for a run that has them, run tools minted and served by the
runner itself. Three things differ from a run on a board:

- It is always headless. An automation set to T3 Code still runs, and its detail says "Ran headless on engine".
- It starts from origin's copy of its base, after a fetch: the default branch, the epic's integration branch
  (`prBase`) or the base the automation named, by the rules a board uses. Nothing names `origin/main`.
- The agent gets the runner's own MCP endpoint (`http://127.0.0.1:<runner port>/mcp`) on top of the CLI's own
  servers, since a machine set up only as a runner has no registration for it.

The runner keeps the run in its own `autopilot_runs` under the board's id while it goes (`autopilot.adopt`), so it
counts in `runsInFlight` (with the commands and scripts going, which an update would cut short just the same), its session's status follows it, and the worktree cleanup finds it later. It logs nothing
on the task and flags nothing: the board's run does.

**Unpushed commits.** A machine has what is on origin. Before a run, and at hand-over, the board looks in its own
checkout for the task's branches (`taskBranches`, plus the branch or base the run names) with commits no branch of
origin has, and says so: on the run's detail, and as a note on the task at hand-over, which the agent on the
machine reads too.

**The board's settings.** A runner's own settings were never set by anyone, so the board sends the ones a machine
works by (`MACHINE_SETTING_KEYS`): auto-review, the round limit, the board reviewer and its budget, the built-in
review skill, the operation models, tiers and profiles, which providers are on, and ticket systems. They go with
`PUT /machine/settings` before a hand-over and a run, and on the next poll after they change or after the machine
turns up on another version (an update, a reinstall). Where each CLI is
(`cliPath`) stays the machine's own, and a review skill kept in a file on the board isn't sent. A board's Autopilot
agent defaults (budget, timeout) are resolved on the board and travel in the run's options.

**Review rounds.** Rounds are part of the working copy, so they open where the rules run: an agent on the machine
moving the task to Review opens round 1 there, by the board's auto-review setting. The runner's own watchdog
(`reviewFallbacks`) picks up a round nobody ran and starts the board reviewer in the task's worktree there: the
folder of its newest session that ran on this machine and still exists. A task with none (its work was done on the
board's machine, or the worktree was cleaned up) is not reviewed in the project's clone, which sits on the default
branch and would show the reviewer no change: the round fails, saying the task has no worktree on the machine. The board's watchdog leaves a held
task's rounds alone. What the board does to a round is an [edit](#edits-from-the-board).

**Commands and scripts.** A custom automation's shell or script action for a held task is a job: it runs in the
machine's clone of the project (not a task's worktree, as on a board it runs in the project's folder), as the user
the runner runs as, with the values in its environment as on a board. The run's summary ends in `on <machine>`, and
the builder's Runs-as-you badge and the script warning name the connected machines. A check script has no task (it
runs once per project), so it runs on the board.

#### Sessions, usage and transcripts

A session's files are on the machine it ran on. A link made there says so: `ref.machine` is the runner's instance
id and name, set by the runner's run and by `link` on a runner's MCP.

| What                | Where it is read                         | How the board gets it                                          |
| ------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| Status and title    | The runner's session poll, which runs with no browser connected | In the task's state: `links[].snapshot`       |
| Token usage         | The runner's usage readers and its runs' own output | Beside the state in each entry: `usage`, the task's rows whole |
| Transcript          | On the runner, by session id and folder  | `POST /machine/transcript`, when `get_session_transcript` asks |

The board never reads, polls or resumes a session whose link names another machine: Open in terminal answers that
it ran on that machine. It stores the usage rows it is sent with `session_usage.machine_id`
([token usage](token-usage.md#on-a-connected-machine)). A transcript can still be read after the task is taken
back, for as long as the machine is connected.

#### Images

A task's pasted images are files in the board's data dir. After a hand-over, and again before each run, the board
sends the ones the machine doesn't have (`PUT /machine/attachments/:id`); the runner keeps them under the board's
ids in its own attachments folder, and drops them with the task's copy when the task is taken back, so every
hand-over sends them all. So the paths an agent is given there (`get_task`'s Images, the reviewer's
`--add-dir`) are the runner's own. Images attached on the machine stay there.

### Tools on a machine

Agents on a runner call `127.0.0.1` as on a board, and get the same tools. `mcp/runnerTools.ts` looks at each call
first:

| The call                                                          | What happens                                                    |
| ----------------------------------------------------------------- | --------------------------------------------------------------- |
| Reads or changes a task the machine holds                         | Runs here: the copy is the newest there is                      |
| Reads something else (`RUNNER_READ_TOOLS`: a task not held, a list, an overview) | Passed to the board, and its answer returned     |
| The same while the board can't be reached                         | A task not held: an error saying so. A list: only what is held here, and a line saying that |
| Changes a task the machine doesn't hold                           | Refused: it is changed on the board                             |
| `add_to_backlog`, `create_task`                                   | Runs here; the task is held by this machine from the start      |
| `create_epic`, merging, threads, Autopilot, suggestions, transcripts | Refused: those are the board's                               |

A folder in a call passed on (`workspacePath`) is replaced by the board's id for that project. The board runs only
the read tools for a machine (`createMachineToolCaller`), through its own `/mcp` endpoint, so the answer is the one
an agent on the board would get. The runner's server instructions end with a paragraph saying all this
(`RUNNER_INSTRUCTIONS`).

### Asking the board

A runner never dials out: the board may be behind a NAT, or reach it only through an SSH tunnel. So what a runner
asks of its board (`integrations/machines/bridgeChannel.ts`: a number for a new task, a tool call) waits until the
board's next poll of the log, which returns at once when there is a question, and the answer comes back as
`POST /machine/replies`. The board counts as reachable while it polled within the last 20 seconds; a question
unanswered after 15 fails as if the board were away.

### Numbers given by a machine

A task's number never changes. A task made on a runner while the board is reachable asks the board for the next
of its own numbers. One made while the board is away takes the machine's prefix and the runner's own counter:
`#E7`. The prefix and the number are two fields (`tasks.number_prefix`, `number`), unique together, so sorting and
lookups stay numeric; `taskLabel` (`packages/contracts/src/taskNumbers.ts`) is how every place prints one, and
`#E7`, `E7`, `e7` and the uuid all name the task wherever a task is referenced
([numbering](task-lifecycle.md#numbering)).

On every poll the board tells the runner its prefix and the highest number it has seen under it
(`counters`: `machine_task_number:<prefix>`), and the runner never numbers below that. The mark is kept by prefix,
not by machine, so a machine reinstalled with an empty data dir and connected under its old prefix carries on
where the old one stopped. The first prefixed task to arrive fixes the machine's prefix (`prefixFixed`).

### Running a runner while developing

`pnpm sandbox --runner` starts a second server in the runner role beside the sandbox's board, on its own free
port, with its own data dir and user home under the sandbox's temp folder. Add `--pollers --seed machine` to try
work on it: the pollers (Autopilot's engine on the board, the review watchdog and session status on the runner) are
otherwise off in a sandbox, and the seed gives the board a project whose repository the runner already has a clone
of, with an agent automation and a script automation to switch on. For an agent without a real one, set a stand-in
script as the provider's CLI path in the runner's settings (`PATCH <runner.url>/api/settings`). The `SANDBOX_READY` line carries
`runner: {url, port, home}`, and `pnpm sandbox stop` stops it with the rest
([sandbox skill](../../.claude/skills/sandbox/SKILL.md)). To pair with it, make a code on its data dir from
`apps/server`: `<ID>_HOME=<runner.home>/data node --import tsx src/main.ts pair --json`, then
`POST /api/machines {"via": "code", "url": "<runner.url>", "code": "<code>"}` on the board. A task is handed over
with `POST /api/tasks/:id/hold {"machineId": "<id>"}`; an agent on the runner is `POST <runner.url>/mcp`. To see the
board catch up, stop its process (`kill -STOP <pid>`, then `-CONT`) or touch a server file so it restarts, and
change the task on the runner meanwhile.

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

- **The log holds states, not operations** ([ADR 0016](../decisions/0016-held-tasks-single-writer.md)). An entry is the task after the change, so applying it is the same
  whichever state the board was in and however often it arrives, and the two sides need not agree on ids or
  clocks. Replaying operations through the board's services would run every rule twice (a review round opened on
  both sides, a PR-merged move made twice) and break on the first id the two sides generated differently. The cost
  is that an entry is the whole task: a few kilobytes a change, dropped once applied.
- **The board shows its own edit before the machine has it.** The service layer is synchronous and the machine is
  a network away, so the edit is applied and queued in one write and settled by the machine's log. The alternative,
  holding every edit until the machine answers, would freeze the card of a task whose machine is off.
- **A long poll, not a stream.** The board's client already sends requests with a token to a verified address and
  a timeout; a read held open for 8 seconds reuses all of it, works through an SSH tunnel and a proxy alike, and is
  the catch-up and the live feed in one. A change still arrives within the request.
- **The runner's questions ride on the board's poll.** Nothing on the runner needs the board's address, a route
  to it, or a credential for it.
- **Held tasks live in the runner's own tables.** A separate store would have needed every tool rewritten against
  it; under the board's ids in the ordinary tables, the tools and services are the ones a board runs.
- **A job the board reads, not a request it holds open.** A run takes an hour and the link may drop in between; a
  job that outlives the request, read in short polls, survives that, and the same polling client already exists.
- **Jobs in memory.** A runner's restart ends its agents anyway, so a stored job would only be a record of work that
  is gone. The board fails the run with the reason, as it does its own after a restart.
- **The board's settings are sent, not asked for.** Rules run on the machine while the board is away (a move to
  Review opens a round), so the machine needs them beforehand; asking the board at that moment would not work.
- **Review rounds in the state, usage beside it.** Rounds are edited from both sides, so they travel both ways with
  the task. Usage is read on the machine only: in the state, a hand-over would have sent the board's own rows there
  and got them back marked as the machine's.
- **A session link names its machine.** After the task is taken back the link is all that is left to say where the
  session's files are; the hold is gone by then.
- **A held task counts as busy for another board.** The list a board publishes with its backup already stops a
  move of a task with work going on; nothing else about a hold is written anywhere a backup reaches.

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
| Replaying operations (the service call and its arguments) on the board | Rules run on both sides, and ids and times differ between them; a state is the same wherever it is written |
| The board proxying every edit to the machine and waiting | A card that can't be touched while its machine is off; the service layer would have to become asynchronous |
| A WebSocket or SSE stream from the runner | A second kind of connection to authenticate, time out and keep alive, for a latency a long poll already gives |
| The runner calling the board | The board would need an address the runner can reach and a credential for it; it has neither |
| A run's progress as log entries | The log is a task's state; a run that fails before touching the task has none to write, and a run is the board's record, not the task's |
| Syncing every setting to the runner | Most are about the board's own machine (terminal, CLI paths, backup); only what work on a task reads is sent |
| Renumbering a machine's tasks when the board sees them | A number in a commit, a branch or a note would point at another task |
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
| `packages/contracts/src/workingCopies.ts` | The log entry formats, `readChangeLogEntry`, and what a board and a runner exchange about a held task |
| `packages/contracts/src/taskNumbers.ts` | `taskLabel`, `parseTaskNumberRef`: a number with a machine's prefix  |
| `apps/server/src/services/workingCopies.ts` | A runner's working copies and change log: taking a task, logging, releasing, applying the board's edits |
| `apps/server/src/services/holds.ts`     | A board's holds: preparing a hand-over, applying log entries, settling edits |
| `apps/server/src/services/heldEdits.ts` | The wrapper that queues edits to a held task, and what a held task refuses |
| `apps/server/src/services/taskState.ts` | Reading a task's state out of a database and writing it into one     |
| `apps/server/src/integrations/machines/sync.ts` | Hand-over, release, the poll loop, sending edits, answering the runner |
| `apps/server/src/integrations/machines/bridgeChannel.ts` | A runner's questions to its board                      |
| `apps/server/src/integrations/machines/checkouts.ts` | A runner's clones of the board's projects                  |
| `apps/server/src/mcp/runnerTools.ts`    | The tools on a runner: what runs here, what is passed on, what is refused |
| `packages/contracts/src/machineJobs.ts` | Jobs, the settings, transcript and image requests                    |
| `apps/server/src/integrations/machines/remoteWork.ts` | The board's side: sending runs, commands and scripts, settings, images, the unpushed check, transcripts |
| `apps/server/src/integrations/machines/runnerWork.ts` | The runner's side: what each job kind does, and taking the board's settings |
| `apps/server/src/integrations/machines/jobs.ts` | A runner's jobs in memory, and the errors that travel        |
| `apps/server/src/http/routes/tasks.ts`  | `POST` and `DELETE /api/tasks/:id/hold`, `POST …/pull-back`, `PUT …/run-on` |
| `packages/contracts/src/runOn.ts`       | `RUN_HERE`, `resolveRunOn`, `runOnLocked`                             |
| `apps/server/src/services/runOn.ts`     | `taskRunsOn`: where a task runs, read on the server                   |
| `apps/server/src/integrations/machines/startOn.ts` | Handing a task to its machine when Start planned starts it  |
| `apps/web/src/components/task/RunOn.tsx`, `runOn.logic.ts` | The panel's chip, the hand-off window's control, the card's number, the offline callout, the waiting marks |
| `apps/web/src/components/settings/ProjectRunOnRow.tsx` | Project settings › Runs on                               |
| `apps/server/src/test/boardAndRunner.ts` | A paired board and runner for tests, with a link that can be cut    |
| `apps/web/src/components/settings/machines/` | The Machines section, the add dialog and their logic            |
| `apps/web/src/state/machines.ts`        | The machines query and its mutations                                  |
| `apps/server/scripts/bundle.ts`         | The bundle, then the tarballs with `--tarballs`                       |
| `apps/server/scripts/tarball.ts`        | The pinned Node, the launcher, the tarballs and their checksums       |
| `apps/server/scripts/sandbox.ts`        | `--runner`                                                            |
| `.github/workflows/release.yml`         | The `server` job                                                      |
