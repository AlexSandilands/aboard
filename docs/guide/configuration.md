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

## Desktop app (Windows)

The desktop app starts the server for you and keeps it running in the tray.

- Closing the window hides it to the tray; agents can still reach MCP. **Quit** from the tray stops the
  server.
- The tray menu has **Copy MCP URL** and **Start at login** (starts hidden in the tray).
- If a server is already running on the port, the app uses it instead of starting a second one.
- Links to PRs, Jira and T3 Code threads open in your browser or T3 Code, not inside the app.
- Server logs are in `%APPDATA%\Aboard\logs\server.log`.

The installer isn't code-signed yet, so Windows SmartScreen warns the first time you run it.
