# Remote machines

Board task: #179, in epic #178 (run tasks on another machine).

A task can be set to run on another machine: a server or a second computer the board connects to. That machine
runs the same server as the board, started in the **runner** role: it serves no board or web app, holds the
tasks sent to it, and runs their agents. This page covers the part that exists so far: the runner role, the
release that puts the server on a machine with nothing installed, and the background service that keeps it
running. Pairing, connecting a machine from the board, held tasks and remote runs aren't built yet; they are
the later tasks of epic #178.

## How it works

### The runner role

`<id>-server --runner` (or `brandEnv("ROLE")=runner`) starts the server in the runner role. `loadConfig` sets
`Config.role`, and a runner has no `webDist`, so nothing but the API, `/events` and `/mcp` is served: `/` is a 404.
Everything else is the same server: the same database and migrations, the same `127.0.0.1` binding and guard. A
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
`brandEnv("HOME")` and `brandEnv("PORT")` when set. A token is never written into the service file.

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

### Running a runner while developing

`pnpm sandbox --runner` starts a second server in the runner role beside the sandbox's board, on its own free
port, with its own data dir and user home under the sandbox's temp folder. The `SANDBOX_READY` line carries
`runner: {url, port, home}`, and `pnpm sandbox stop` stops it with the rest
([sandbox skill](../../.claude/skills/sandbox/SKILL.md)). Two roles on one machine is what the later tasks of the
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

## Alternatives considered

| Option                                   | Why not chosen                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| Publish the server to npm                | Needs Node 24 and npm on the machine, and a global install per user                  |
| A single executable (Node SEA)           | Needs a build per platform on its own runner, and `migrations/` as embedded assets   |
| Run the server from the desktop app      | Electron's run-as-node fuse is off, and a headless server has no display for Electron |
| A system-wide systemd unit               | Needs root, and runs as a user who has none of the agent logins                      |

## Code map

| File                                    | What it does                                                         |
| --------------------------------------- | -------------------------------------------------------------------- |
| `apps/server/src/main.ts`               | Arguments: `--runner`, `--version`, `--help`, `service …`             |
| `apps/server/src/config.ts`             | `role`, from `--runner` or `brandEnv("ROLE")`; a runner has no `webDist` |
| `apps/server/src/app.ts`                | `/api/health` with the role                                           |
| `apps/server/src/service/cli.ts`        | `service install`, `uninstall`, `status`                              |
| `apps/server/src/service/definitions.ts` | The systemd unit and launchd plist                                   |
| `apps/server/scripts/bundle.ts`         | The bundle, then the tarballs with `--tarballs`                       |
| `apps/server/scripts/tarball.ts`        | The pinned Node, the launcher, the tarballs and their checksums       |
| `apps/server/scripts/sandbox.ts`        | `--runner`                                                            |
| `.github/workflows/release.yml`         | The `server` job                                                      |
