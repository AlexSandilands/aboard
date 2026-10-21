# apps/desktop

The Electron shell. How it works: [docs/features/desktop.md](../../docs/features/desktop.md).

- The main process (`src/main.ts`) only manages the window, tray and server lifecycle. Board features
  belong in the server or the web app, never here.
- It attaches to a server already answering `/api/health` with our id, otherwise it runs the esbuild
  server bundle (`apps/server/dist/server.mjs`, `pnpm --filter @repo/server bundle`) in a
  `utilityProcess`. That process talks back over `process.parentPort` (`ready` / `shutdown`) in
  `apps/server/src/main.ts`; keep both sides in step.
- The window is frameless with native controls painted over the page (T3 Code's `titleBarOverlay`). The
  web app reads `navigator.windowControlsOverlay` (`.wco` class) and reports its theme through the
  preload's `window.desktopBridge` (`DesktopBridge` in contracts).
- The preload is sandboxed and bundled to CJS. Anything it exposes must be typed in
  `packages/contracts/src/desktop.ts`, and the main process checks the sender before acting on IPC.
- Packaging config is code (`scripts/package.ts`) so names derive from `BRAND`. `pnpm desktop:package`
  (from the root) builds the current OS's packages in `apps/desktop/release/`: the Windows installer, or the
  Linux AppImage, .deb, .rpm and tarball. Releases build them in CI ([releases](../../docs/features/releases.md)).
- It runs on Windows and Linux. Anything OS-specific needs both paths, like `loginItem.ts`.
- Scripts in `scripts/` run on plain `node` (type stripping): erasable TypeScript only.
- Pure logic goes in `src/shell.logic.ts`, with tests beside it. Changes under `apps/desktop` need a
  restart of `pnpm desktop`. Its dev script waits on the fixed ports :4317 / :5317, so it is for the main
  checkout only. From a worktree try shell changes with `pnpm sandbox --desktop` (stop it with
  `pnpm sandbox stop`).
- The sandbox shell is told apart by `brandEnv("DESKTOP_SANDBOX")` (set by `desktopSandboxEnv` in
  contracts). `main.ts` refuses to start when `readDesktopSandbox` finds the real data dir or the real
  ports, and keeps its profile and lock inside the sandbox's home. Keep any new per-user state
  (paths, ports, tokens) behind that check.
