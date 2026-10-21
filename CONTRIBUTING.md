# Contributing

Conventions for people and agents are in [AGENTS.md](AGENTS.md), with one per app. Design docs (how
each feature works and why) are in [docs/](docs/README.md).

## Setup

You need Node 24+ and pnpm.

```sh
pnpm install     # also installs the git hooks
```

## Running

```sh
pnpm dev         # server on :4317, Vite on http://127.0.0.1:5317
pnpm desktop     # pnpm dev plus an Electron window on the Vite server
pnpm sandbox     # this checkout on free ports with a throwaway data dir and example data
pnpm sandbox --desktop   # the same, plus an Electron window ("Sandbox" in its title) on it
```

`pnpm dev` and `pnpm desktop` use your real data folder and the default ports. From a git worktree, or
whenever you don't want to touch your own board, use `pnpm sandbox` instead (`pnpm sandbox stop` ends
it). `pnpm sandbox --desktop` is the way to try the Electron shell from a worktree; it can run beside
your real desktop app.

In `pnpm desktop`, web edits hot-reload and server edits restart the server (the board reconnects on its
own). Changes under `apps/desktop` need a restart. To try the built app without packaging it:
`pnpm desktop:build && pnpm --filter @repo/desktop start`.

### Stopping on Windows

Stop with `Ctrl+C`. Each script runs through `cmd`, which asks `Terminate batch job (Y/N)?`: answer `y`
(more than once if asked), and run `reset` if the terminal is left garbled. To check nothing is still
holding the ports:

```sh
netstat -ano | grep -E "127.0.0.1:(4317|5317) " | grep LISTEN   # empty when everything has stopped
taskkill //PID <pid> //T //F                                    # for anything still listed
```

`ABOARD_PORT` moves the server and `ABOARD_WEB_PORT` moves Vite. The server only accepts browser writes
from its own port and the Vite port.

### Screenshots

The README GIF (`demo.gif`) and the task panel screenshot (`task-panel.png`) in `.github/assets/` are
recorded from `pnpm sandbox --seed showcase`, a busy example board, so they never show real work. Retake
both when the UI changes:

```sh
pnpm exec playwright install chromium   # once
pnpm demo:record                        # restarts this checkout's sandbox, records, writes both files
```

It needs ffmpeg, and [gifski](https://gif.ski) for a clean GIF (without it the script falls back to
ffmpeg's palette, which bands more). `scripts/demo/director.ts` plays the beats with a drawn cursor in
headless Chromium at twice the pixels; `encode.ts` adds the zooms afterwards, trims and encodes, and
warns over 6 MB. The take stays in a temp folder (`/tmp/demo-take`), so `node scripts/demo/encode.ts
/tmp/demo-take` re-encodes it without recording again.

The sandbox's pollers are off, so what the GitHub poller and Autopilot would do goes through
`/api/demo`, which only the sandbox registers: it changes a PR link's checks and starts and finishes
pretend Autopilot runs, through the same service calls the poller and the engine make. Starting a
session is stubbed too: the director points the terminal at `true {command}` and the Claude Code CLI path
at a script that only answers `--version`, so nothing real is launched.

## Checks

```sh
pnpm check       # format, lint, typecheck, unused code (knip), doc links, tests
pnpm format      # apply formatting
```

The git hooks (lefthook) format, lint and check the commit message on commit. CI runs `pnpm check` on
Ubuntu and Windows for every PR. Commits and PR titles follow Conventional Commits:
`feat(web): add favicon options`.

## Releasing

Publish a release on GitHub with a date tag (`v2026.10.21`) and generated notes; CI builds the installers,
attaches them and updates the pacman repo. Details and one-time setup:
[docs/features/releases.md](docs/features/releases.md).

## Layout

| Path                 | What                                                       |
| -------------------- | ---------------------------------------------------------- |
| `packages/contracts` | Shared zod schemas, types and helpers                      |
| `apps/server`        | Hono server: REST, SSE, MCP, `node:sqlite`, integrations   |
| `apps/web`           | The board: React, Tailwind v4, Base UI                     |
| `apps/desktop`       | Electron shell                                             |
| `skills/`            | The skill and snippet shipped to agents that use the board |

UI primitives and design tokens are adapted from T3 Code under the MIT license; see [NOTICE](NOTICE).
