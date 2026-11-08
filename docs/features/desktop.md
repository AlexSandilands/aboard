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
- The tray menu: Open, **Copy MCP URL** (with `?token=` when set), **Tray icon**, **Start at login**
  (packaged only; starts hidden), **Check for updates automatically**, the update item ([updates](#updates)),
  **Restart server**, Quit. Every item has an icon. On Linux Start at login is a
  plain item whose icon is a ticked or empty square, because Qt menus put a real checkbox in a column left of the
  icons; elsewhere it is a checkbox.
  Electron's login items only exist on Windows and macOS, so on Linux the item writes
  (or removes) a desktop entry in the XDG autostart folder, `~/.config/autostart/<id>.desktop`
  (`apps/desktop/src/loginItem.ts`). It runs the AppImage file itself when started from one.
- **Menu icons** are Lucide outlines, inlined in `scripts/build.ts` and rendered to `dist/icons/menu/` in a
  light set (dark ink) and a dark set. `buildTrayMenu` picks the set from `nativeTheme.shouldUseDarkColors`
  (on Windows, `shouldUseDarkColorsForSystemIntegratedUI`) and rebuilds the menu on `nativeTheme` "updated".
  On Linux they travel over dbusmenu: KDE shows them, but a GNOME AppIndicator extension may not, and the
  items work without them. On Linux the set follows the board's light/dark choice too, since that sets
  `themeSource`, so it can differ from the panel's.
- **Tray icon** is a radio submenu: Colour (the default, the app icon), White and Black (the "A" and card bar
  as one solid glyph, `apps/desktop/assets/a-card-mono.svg`, recoloured at build time), so the icon can match
  a panel that draws monochrome icons, like KDE's. There is no "Auto": a shell can't tell what the panel
  looks like. The choice applies at once and is kept in `prefs.json` in the shell's `userData` folder
  (`desktopPrefs.ts`), not in the board's settings. A missing or corrupt file means Colour.
- **Restart server** stops the server the shell runs, starts it again and reloads the window. It is disabled
  when the shell only attached to one it didn't start (`pnpm dev`, or a sandbox shell). While it runs the
  item reads "Restarting server…" and is disabled. If the new server doesn't start, the same dialog as at
  startup shows (Quit quits, Open log folder leaves the tray running) and the item can be tried again.
  Quitting mid-restart waits for it, then stops what it started.
- A single-instance lock brings the existing window forward. The dev app is named `<Name> Dev`, so its
  data folders and lock never clash with an installed copy.
- Navigation: same-origin URLs load in the window; `http`, `https`, `mailto` and `t3code` links open in
  the system; anything else is blocked (`decideNavigation` in `shell.logic.ts`).

### Notifications and badges

The page asks the shell, through `window.desktopBridge`, to show an OS notification (`notify`) and to show the
unread count (`setBadge`); clicks come back through `onNotificationClick`. The main process checks the
sender's origin and validates both payloads (`parseDesktopNotification`, `parseDesktopBadge`) before acting.
On Windows the taskbar count is an overlay image the page draws; elsewhere it is `app.setBadgeCount`. The tray
icon swaps to a red-dot variant of the chosen style while anything is unread. What produces notifications and when they pop up is
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

### Updates

The packaged app updates itself from the project's GitHub releases (`apps/desktop/src/updater.ts`). It checks, downloads
in the background, and installs only when you click **Restart to update**.

- **Modes** (`updateMode` in `shell.logic.ts`). The Windows installer and the AppImage **self-update** with
  electron-updater (`NsisUpdater` / `AppImageUpdater`, built explicitly: electron-updater's own pick would use the
  pkexec-based .deb/.rpm/pacman updaters). The .deb, .rpm, tarball and the Arch packages are **notice-only**: the
  shell reads the latest release's `latest-linux.yml` (where `resources/app-update.yml` points, `noticeFeedUrl`), compares its version with `BRAND.version` and says a newer
  one is out, with "update with pacman -Syu" for the Arch packages (running from `/opt/<id>/` with pacman installed and no `resources/package-type`) and "download it from the release page" for the rest. Nothing writes over a package manager's files.
  Updates are **disabled** in dev builds, the sandbox shell and builds from source (a version that isn't a release's
  date, like `0.1.0`), and nothing touches the network then.
- **Feed.** `package.ts` gives electron-builder a `github` publish config with the owner and repo from the root
  `package.json` `repository` (`BRAND_REPOSITORY`), so it writes `resources/app-update.yml` and the `latest*.yml`
  feed; it never publishes. CI uploads the feed last ([releases](releases.md#the-workflow)).
- **When.** 15 seconds after start, then hourly, while **Check for updates automatically** is on (`autoCheckUpdates`
  in `prefs.json`, default on). **Check now** works either way. `autoDownload` is on and `autoInstallOnAppQuit` off,
  so a quit (Windows shutting down, say) never starts an installer. A check that fails is quiet: a 404 (the release's
  files still uploading) or no network reads "Couldn't reach GitHub…" in Settings and is tried again within the hour.
- **State.** One `DesktopUpdateState` (contracts): `mode`, `status` (`idle`, `checking`, `up-to-date`, `downloading`
  with `percent`, `ready`, `installing`, `available`, `error`), the new `version`, `checkedAt`, `error`. `reduceUpdate`
  moves it; a ready update survives later checks and errors, and so does a version a notice-only install knows of.
- **Installing** (`installUpdate` in `main.ts`). The state goes to `installing`, the shell waits for a server restart
  in flight, stops the server it owns (gracefully: the WAL checkpoint) and calls `quitAndInstall(true, true)`: the
  per-user NSIS installer runs silently with no admin prompt and starts the new version; the AppImage replaces its
  file and relaunches. An attached server isn't ours and stays up. If the installer can't start, the state goes back
  to `ready` with the error, the server starts again and the window reloads. **Restart server** is disabled meanwhile.
- **Where it shows.** The **tray** has **Check for updates automatically** (under Start at login, a square icon on
  Linux) and one update item that follows the state (`updateMenuItem`): Check for updates, Checking…, Downloading vX…
  n%, Restart to update to vX, vX available: release notes, or a disabled "Updates off in dev builds". An **OS
  notification** says once per version (`notifiedUpdate` in `prefs.json`) that an update is ready, or available on a
  notice-only install; clicking it opens Settings → Board → **Desktop app** through `onNotificationClick` with
  `settingsTarget`. That **Settings** section shows the version, the status and the matching button, and the same
  auto-check switch ([board layout](board-layout.md#the-settings-page)). While an update is ready, a **Restart to
  update** pill sits in the title bar just left of the native controls (`components/desktop/UpdatePill.tsx`, mounted
  once in `AppShell`); it sets `--title-bar-pill-space`, which `--workspace-native-controls-inset` adds, so whichever
  top bar is at the right edge makes room.
- **Bridge.** `getUpdateState`, `onUpdateState`, `checkForUpdates`, `installUpdate`, `setAutoCheckUpdates`,
  `openReleaseNotes`, all optional on `DesktopBridge` (a page can be newer than its shell). The main process checks
  the sender like every other channel; the page reads state through `useDesktopUpdate`, which validates it.
- **Trying it.** `pnpm desktop:package AppImage tar.gz` with the root `package.json` version set to a release date
  builds an app that checks; `brandEnv("UPDATE_FEED_URL")` set to a URL while packaging (test builds only, see
  `package.ts`) points it at a `generic` feed you serve yourself, with a newer build's AppImage and `latest-linux.yml`.

### Building and packaging

- `scripts/build.ts`: esbuild bundles `src/main.ts` (ESM) and `src/preload.ts` (CJS, since the preload is
  sandboxed), and rasterises the favicon into window and tray icons, the mono logo into the white and black ones, and the menu icons.
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
- **Updates install on a click, never by themselves.** The download happens in the background, but restarting stops
  the server agents are talking to, so the user picks the moment. Updates aren't signature-checked until the
  installer is signed (#18 sets `win.publisherName`); the sha512 in the feed over HTTPS is the check meanwhile.
- **Package-manager installs are only told.** Replacing a .deb's or pacman's files from the app would leave the
  package manager's database wrong and need root.

## Code map

| File                                  | What it does                                                     |
| ------------------------------------- | ---------------------------------------------------------------- |
| `apps/desktop/src/main.ts`            | Window, tray, single instance, quit, theme IPC                   |
| `apps/desktop/src/desktopPrefs.ts`    | `prefs.json`: tray icon style, auto-check, last notified update  |
| `apps/desktop/src/updater.ts`         | `Updater`: checks, downloads, installs; the update state         |
| `apps/desktop/src/icon.ts`            | Window, tray and menu icon images                                |
| `apps/desktop/src/server.ts`          | `connectServer`: probe, attach, spawn, stop                      |
| `apps/desktop/src/shell.logic.ts`     | Pure helpers (tested): health check, navigation, log tail, update mode and state |
| `apps/desktop/src/titleBar.ts`        | Title bar overlay options and sync                               |
| `apps/desktop/src/loginItem.ts`       | Start at login: Electron's login item, or an XDG autostart entry on Linux |
| `packages/contracts/src/desktop.ts`   | `desktopSandboxEnv`, `readDesktopSandbox` (sandbox shell wiring and guard) |
| `apps/desktop/src/preload.ts`, `ipc.ts` | `window.desktopBridge`                                         |
| `apps/desktop/scripts/*.ts`           | Build, launch, package                                           |
| `apps/server/scripts/bundle.ts`       | The server bundle                                                |
| `apps/web/src/lib/windowControlsOverlay.ts`, `hooks/useTheme.ts` | The web side of the title bar and theme |
| `apps/web/src/components/desktop/*`   | `useDesktopUpdate`, the Desktop app settings section, the update pill |
