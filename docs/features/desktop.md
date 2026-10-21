# Desktop app

An Electron shell for Windows and Linux. It runs the server in the background and keeps it in the tray, so the
board and the MCP endpoint are up without a terminal. The main process only manages the window, the tray
and the server's lifecycle; the board itself is the same web app and server as in the browser.

## How it works

### Attach or spawn

On start (`apps/desktop/src/server.ts`, `connectServer`) the shell probes
`http://127.0.0.1:<port>/api/health`:

| Answer                              | Shell does                                                        |
| ----------------------------------- | ----------------------------------------------------------------- |
| Our health (`id` matches `BRAND.id`) | Attaches. It never stops a server it didn't start                |
| Something else                      | Fails: the port is used by another app                            |
| Nothing, in dev (`brandEnv("DEV_URL")` set) | Fails: start the app with `pnpm desktop`                  |
| Nothing                             | Spawns the server                                                 |

Spawning forks the bundled server (`apps/server/dist/server.mjs`, from `pnpm --filter @repo/server bundle`)
in an Electron `utilityProcess`. It gets the port through env vars (and, when packaged, the
bundled web dist), plus `NODE_NO_WARNINGS`. Its output goes to `server.log` in the app's logs folder; startup failures show the
last 40 lines in a dialog.

### The server's side

`apps/server/src/main.ts` talks to the shell over `process.parentPort`:

- it posts `{type: "ready", url}` once listening (the shell waits up to 30 seconds);
- on the message `"shutdown"` it closes the server and database and exits. The shell sends it on quit and
  kills the process after 5 seconds. A clean stop checkpoints the SQLite WAL, which a kill skips on
  Windows.

An unexpected exit after startup shows an error and quits the app.

### Window and tray

- Closing the window hides it to the tray, so agents keep their MCP endpoint. **Quit** in the tray stops
  an owned server first.
- The tray menu: Open, **Copy MCP URL** (with `?token=` when set), **Start at login** (packaged only;
  starts hidden), Quit. Electron's login items only exist on Windows and macOS, so on Linux the item writes
  (or removes) a desktop entry in the XDG autostart folder, `~/.config/autostart/<id>.desktop`
  (`apps/desktop/src/loginItem.ts`). It runs the AppImage file itself when started from one.
- A single-instance lock brings the existing window forward. The dev app is named `<Name> Dev`, so its
  data folders and lock never clash with an installed copy.
- Navigation: same-origin URLs load in the window; `http`, `https`, `mailto` and `t3code` links open in
  the system; anything else is blocked (`decideNavigation` in `shell.logic.ts`).

### Notifications and badges

The page asks the shell, through `window.desktopBridge`, to show an OS notification (`notify`) and to show the
unread count (`setBadge`); clicks come back through `onNotificationClick`. The main process checks the
sender's origin and validates both payloads (`parseDesktopNotification`, `parseDesktopBadge`) before acting.
On Windows the taskbar count is an overlay image the page draws; elsewhere it is `app.setBadgeCount`. The tray
icon swaps to a red-dot variant while anything is unread. What produces notifications and when they pop up is
in [notifications](notifications.md).

### Title bar

The window is frameless with Windows' native controls painted over the page (`titleBarOverlay`, 40px,
`titleBar.ts`).

- The web app detects it with `navigator.windowControlsOverlay` and sets a `.wco` class on `<html>`
  (`apps/web/src/lib/windowControlsOverlay.ts`). CSS uses it to size the top bars and keep content clear of
  the controls (`--workspace-native-controls-inset`).
- Top bars carry `.drag-region`; buttons and inputs inside them opt out of dragging.
- The web app reports its theme through `window.desktopBridge.setTheme` (`DesktopBridge` in
  `packages/contracts/src/desktop.ts`, exposed by `preload.ts`). The main process checks the sender's
  origin, sets `nativeTheme` and recolours the overlay. It also sends the theme's background as `#rrggbb` through
  `setBackgroundColor` (optional on the bridge, as older shells lack it), which the shell paints the window and the
  overlay with instead of its default ([appearance.md](appearance.md)). In a plain browser `desktopBridge` is absent.

### Building and packaging

- `scripts/build.ts`: esbuild bundles `src/main.ts` (ESM) and `src/preload.ts` (CJS, since the preload is
  sandboxed), and rasterises the favicon into window and tray icons.
- `scripts/launch.ts`: builds, then runs Electron. `--dev` points the window at Vite (5317).
- `scripts/package.ts`: electron-builder, into `apps/desktop/release/`, for the OS it runs on: the NSIS
  installer on Windows; AppImage, .deb, .rpm (needs rpmbuild) and a tarball on Linux. Name targets to build
  only those: `pnpm desktop:package tar.gz`. App id, product name, executable and file names all come from
  `BRAND`. The server bundle and the web dist ship as extra resources, and the license and `NOTICE` sit beside
  the executable. On Linux the window's app id is `<id>.desktop`, so docks match it to the menu entry. Electron
  fuses turn off run-as-node, `NODE_OPTIONS` and inspect flags. Releases run it in CI
  ([releases.md](releases.md)).

`pnpm desktop` runs the dev server, Vite and the shell together; the shell waits for both to answer, then
attaches.

### Against a sandbox

`pnpm desktop` uses the real data dir and the real ports (:4317 / :5317), so it is for the main checkout.
Anywhere else, `pnpm sandbox --desktop` starts (or reuses) this checkout's sandbox, then opens the shell on
it (`openDesktop` in `apps/server/scripts/sandbox.ts`). `--live` is refused: the shell must never attach to
the real board. The shell is a dev shell like `pnpm desktop` (it loads the sandbox's Vite and attaches to
its server, never spawning one) with these differences:

- `desktopSandboxEnv` (contracts) gives it the sandbox's ports, `DEV_URL` and `brandEnv("DESKTOP_SANDBOX")`
  (the sandbox's home), and drops the user's token and data dir.
- It is named `<Name> Sandbox`: the window title ends in "- Sandbox", and the tray tooltip, the tray's
  Open item and the app user model id say so too. Its `userData` (profile, logs, single-instance lock) is
  `<sandbox home>/desktop`, so it runs beside the real app and other worktrees' sandboxes, and
  `pnpm sandbox stop` deletes it.
- Before starting, `readDesktopSandbox` checks the setup and the shell exits with a message if it would
  touch the real data dir or a real port.

The sandbox state file records the shell's pid. `pnpm sandbox stop` (and Ctrl+C on the sandbox) closes it,
only when the pid is still the process the sandbox started. Its output goes to `desktop.log` in the sandbox
home; `--desktop` waits a few seconds and reports the log if the shell exits at once.

## Decisions

- **Attach rather than run a second server.** Two servers on one SQLite file would fight, and agents
  should see one board whether it was started from a terminal or the app.
- **A `utilityProcess`, not the main process.** The server keeps its own event loop, apart from the
  window, and it's the same bundle that runs on plain Node. The shell still quits if the server dies, since
  the window is useless without it.
- **Packaging config is code.** `package.ts` derives every name from `BRAND`, so renaming the product is a
  `package.json` change.

## Code map

| File                                  | What it does                                                     |
| ------------------------------------- | ---------------------------------------------------------------- |
| `apps/desktop/src/main.ts`            | Window, tray, single instance, quit, theme IPC                   |
| `apps/desktop/src/server.ts`          | `connectServer`: probe, attach, spawn, stop                      |
| `apps/desktop/src/shell.logic.ts`     | Pure helpers (tested): health check, navigation, log tail        |
| `apps/desktop/src/titleBar.ts`        | Title bar overlay options and sync                               |
| `apps/desktop/src/loginItem.ts`       | Start at login: Electron's login item, or an XDG autostart entry on Linux |
| `packages/contracts/src/desktop.ts`   | `desktopSandboxEnv`, `readDesktopSandbox` (sandbox shell wiring and guard) |
| `apps/desktop/src/preload.ts`, `ipc.ts` | `window.desktopBridge`                                         |
| `apps/desktop/scripts/*.ts`           | Build, launch, package                                           |
| `apps/server/scripts/bundle.ts`       | The server bundle                                                |
| `apps/web/src/lib/windowControlsOverlay.ts`, `hooks/useTheme.ts` | The web side of the title bar and theme |
