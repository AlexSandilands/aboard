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

The README GIF and the screenshots in `.github/assets/` are taken from `pnpm sandbox --seed showcase`, a
busy example board, so they never show real work. Retake them from that seed when the UI changes.

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
attaches them and updates the AUR package. Details and one-time setup:
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
