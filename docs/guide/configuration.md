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

The board is one SQLite file in the data dir. To keep a copy off the machine, open **Settings → Board → Data**,
choose an empty folder and, optionally, a remote, and turn it on. The server writes the board as JSON into
that folder (one file per task), commits when anything changed, and pushes using your machine's git
credentials, so no token is stored. Use a private repo: task text, notes and links end
up in its history for good. The T3 token and the backup settings are never exported.

From the command line:

```sh
pnpm backup export                       # into <data dir>/backup (or --dir <folder>, --file board.json)
pnpm backup import <folder|file>         # restore a whole board; stop the server first
pnpm backup import <folder|file> --force # replace an existing board (the old file is kept beside it)
pnpm backup restore-task <folder|file> 42   # put task #42 back, with its plan and history
```

A backup taken by an older version restores into a newer one. See
[docs/features/backup.md](../features/backup.md).

## Desktop app (Windows)

The desktop app starts the server for you and keeps it running in the tray.

- Closing the window hides it to the tray; agents can still reach MCP. **Quit** from the tray stops the
  server.
- The tray menu has **Copy MCP URL** and **Start at login** (starts hidden in the tray).
- If a server is already running on the port, the app uses it instead of starting a second one.
- Links to PRs, tickets and T3 Code threads open in your browser or T3 Code, not inside the app.
- Server logs are in `%APPDATA%\Aboard\logs\server.log`.

The installer isn't code-signed yet, so Windows SmartScreen warns the first time you run it.
