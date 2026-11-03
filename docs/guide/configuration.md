# Configuration

The defaults work for most people; nothing here is required.

## Data

Everything lives in `~/.aboard/`. Set `ABOARD_HOME` to use a different folder. The browser and the
desktop app share it, so it's one board however you open it.

## Network and ports

The server only listens on `127.0.0.1`, port 4317. Set `ABOARD_PORT` to move it. All environment
variables use the `ABOARD_` prefix.

## Access token

Set `ABOARD_TOKEN` to require a bearer token on the API and the MCP endpoint. With a token set, open the UI at `http://127.0.0.1:4317/#token=<token>`; the page keeps it for the browser tab and strips it from the address bar. Agents send it as an `Authorization: Bearer` header.

## Backup and restore

The board is one SQLite file in the data dir. To keep a copy off the machine, open **Settings → Board → Data**
and click **Set up backup**. It asks for a folder (`<data dir>/backup` unless you pick another), then where to
push:

- **Create a private GitHub repo**, with the [GitHub CLI](https://cli.github.com/) (`gh`) signed in as you
  (`gh auth login`).
- **Use an existing repo**: paste its URL and click **Check**. The board checks your git can read it and lists
  the machines already backing up to it.
- **Keep backups on this machine**: commits stay in the folder only.

It then turns backup on and takes the first backup, showing whether it was committed and pushed. The server writes
the board as JSON into that folder (one file per task), commits when anything changed, and pushes using your
machine's git credentials, so no token is stored. Use a private repo: task text, notes and links end
up in its history for good. The T3 token and the backup settings are never exported.

While backups have no remote, the section says **Local only: commits aren't pushed**, with a **Connect GitHub**
button that opens the same steps. The rows below it change the folder, remote, machine name and interval later.

Several machines can share one backup repo: each writes into a folder of its own, named after the machine
(the host name, kept from the first backup, unless you set **Machine name** in the same section). Give each machine a different name; a
name another machine's folder already has is refused. Renaming a machine moves its folder on the next backup.
A backup repo made by an earlier version, with the board at its root, is moved into this machine's folder by
the first backup after you update, and the inbox tells you so. Update every machine that backs up to that
repo: older versions refuse a repo laid out this way rather than write over it.

**Restore…** in the same section brings things back from any backup commit, while the board keeps running. Pick a
machine's folder (this machine's by default) and a commit, then either:

- **Tasks**: the tasks missing from the board or changed since that backup. Tick the ones you want back; a
  changed task is replaced by the backup's version.
- **Whole board**: replaces the board with the backup, after you type RESTORE. The board as it was is copied
  beside the database first (`data.sqlite.before-restore-<time>`). This machine's own setup (the backup folder,
  the T3 token, Autopilot's pause) stays. Restoring another machine's folder asks whether this is the same board
  on new hardware, in which case this machine takes that folder over and backs up into it, or a new board, which
  keeps backing up to this machine's own folder.

### Working across machines

To carry on with tasks on another machine (the desktop at home, the laptop on the road), back both machines up to
the same repo, then on the machine you're switching to open **Settings → Board → Data → Move tasks…**. Pick the
other machine (the list says how old its last backup is: anything done there since isn't in it), tick the tasks
and choose:

- **Move** (the default): the tasks come onto this board, and the other machine archives its copies at its next
  backup run. Their cards there say where they went ("Moved to laptop #57"). If one changed there after the backup
  you took it from, it's still archived and the inbox says so, so you can carry the change over by hand. A task an
  agent session or Autopilot run was working on at that backup can't be moved, only copied, and neither can one
  that machine already moved somewhere else: move it from there.
- **Copy**: the tasks come onto this board and stay on the other one too; the two copies then go their own ways.

Each task gets a number on this board and goes into the matching project: the same repo (by its `origin`), else
the same name, else the one you pick. Pull request and ticket links come along; T3 thread and agent session links
stay behind, since those sessions run on the other machine. A task already on this board can't come in again,
but moving one back to the machine it came from puts it back where it was, under its old number.

From the command line:

```sh
pnpm backup export                       # into <data dir>/backup (or --dir <folder>, --file board.json)
pnpm backup import <folder|file>         # restore a whole board; stop the server first
pnpm backup import <folder|file> --force # replace an existing board (the old file is kept beside it)
pnpm backup restore-task <folder|file> 42   # put task #42 back, with its plan and history
pnpm backup import <repo> --machine laptop  # a backup repo with several machines: pick one
```

A folder can be a backup repo, one machine's folder in it, or an older backup with the board at its root.

A backup taken by an older version restores into a newer one. See
[docs/features/backup.md](../features/backup.md).

## Desktop app

The desktop app, for Windows and Linux, starts the server for you and keeps it running in the tray. Get it
from the [releases](https://github.com/AlexSandilands/aboard/releases) or, on Arch, the board's pacman repo (see the
[README](../../README.md#install)).

- Closing the window hides it to the tray; agents can still reach MCP. **Quit** from the tray stops the
  server.
- The tray menu has **Copy MCP URL** and **Start at login** (starts hidden in the tray).
- If a server is already running on the port, the app uses it instead of starting a second one.
- Links to PRs, tickets and T3 Code threads open in your browser or T3 Code, not inside the app.
- Server logs are in `%APPDATA%\Aboard\logs\server.log` on Windows and `~/.config/Aboard/logs/server.log` on
  Linux.
- On Linux the tray icon needs a desktop with a system tray: KDE Plasma has one, GNOME needs the
  AppIndicator extension. **Start at login** adds the app to `~/.config/autostart`.

The installer isn't code-signed yet, so Windows SmartScreen warns the first time you run it.
