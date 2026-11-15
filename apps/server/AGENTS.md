# apps/server

Hono on Node 24 with `node:sqlite`: REST (`/api`), SSE (`/events`), MCP (`/mcp`) and the GitHub, T3 Code
and review integrations. How it fits together: [docs/architecture.md](../../docs/architecture.md).

## Where things go

- `services/*` holds all business logic. REST routes (`http/routes`), MCP tools (`mcp/tools`) and
  pollers (`integrations`) stay thin: parse, call a service, format
  ([ADR 0001](../../docs/decisions/0001-service-layer.md)).
- Board data SQL lives in `db/repos/*` (thin and typed, no ORM); migrations and transactions are in
  `db/database.ts`.
- `integrations/*` talks to the outside world (`gh`, T3 Code, `claude -p`). Inject process and network
  calls so tests can fake them (see `test/fakeT3Socket.ts`).

## Rules

- Every mutation runs inside `core.write(fx => …)` (`services/core.ts`). That gives one transaction, a
  `task_events` row for each `fx.log`, and `BoardEvent`s published after COMMIT. Mark what changed with
  `fx.task` / `fx.project` / `fx.detail` so open browsers update.
- Services throw `AppError` codes from `errors.ts` (`NOT_FOUND`, `VALIDATION`, `CONFLICT`,
  `PLAN_REQUIRED`, `INTERNAL`). Routes and tools map them; don't build error responses by hand.
- Schema changes are new numbered files in `db/migrations/`. Never edit a shipped migration.
- The server binds `127.0.0.1` only. Keep the Host/Origin guard in `http/guard.ts` intact
  ([ADR 0003](../../docs/decisions/0003-localhost-guard.md)).
- The one exception is a runner's machine API, `/machine/*`, which a board on another machine calls with a paired
  token ([ADR 0015](../../docs/decisions/0015-machine-api-auth.md)). Register its routes in `http/routes/machine.ts`
  and let the guard check the token (`machinePairingOf(c)`). Only `integrations/machineClient.ts` sends a machine
  token anywhere, and nothing returns `machine-tokens.json` through the API. The board's side is
  `integrations/machines/`: talk to a connected machine through `integrations.machines.request`, which uses the
  route that works and refuses a machine that isn't connected.
- A task a connected machine holds is changed on that machine. Change tasks only through the service methods (they
  are wrapped in `services/heldEdits.ts`, which queues the edit for the machine); a new method that changes a task
  needs a route there, or its change is overwritten by the machine's next log entry. Print a task's number with
  `taskLabel`, never `#${task.number}`: a machine numbers its own tasks `#E7`
  ([remote machines](../../docs/features/remote-machines.md#held-tasks)).
- MCP results are plain text. Tool descriptions are written for agents; read
  [docs/features/mcp.md](../../docs/features/mcp.md) before adding or changing a tool, and update
  `skills/aboard/` when the workflow changes (then `pnpm skill:embed`, which the installed copies sync from).
- `dev` and `start` run through `tsx` (`tsx watch`, `node --import tsx`), because some code uses syntax Node's type
  stripping can't run (parameter properties). `dev` must not use `node --watch`: on NTFS it restarts when a
  file is merely read, which kills Autopilot runs. `scripts/dev.ts` starts `tsx watch` with stdin ignored:
  under `concurrently` on Windows, an inherited idle stdin pipe hangs the server before it listens.
  `scripts/bundle.ts` builds `dist/server.mjs` for the desktop app, and with `--tarballs` the headless server
  release for remote machines (`scripts/tarball.ts`, [remote machines](../../docs/features/remote-machines.md)).
- `--runner` starts the runner role, which serves no web app; `/api/health` reports the role, and `pair` makes its
  pairing codes. Code that only a
  board should run checks `config.role`.

## Tests

- vitest, files next to the code (`*.test.ts`).
- Go through `src/test/harness.ts`: it builds the real app on an in-memory database with pollers off,
  calls it with `app.request` (no port) and collects published events.
- MCP tests use the SDK client against the same app (`mcp/mcp.test.ts`).
- No network: fake `gh`, T3 and the CLI.
