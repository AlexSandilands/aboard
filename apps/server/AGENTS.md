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
- MCP results are plain text. Tool descriptions are written for agents; read
  [docs/features/mcp.md](../../docs/features/mcp.md) before adding or changing a tool, and update
  `skills/aboard/` when the workflow changes.
- `dev` and `start` run through `tsx` (`node --import tsx`), because some code uses syntax Node's type
  stripping can't run (parameter properties). `scripts/bundle.ts` builds `dist/server.mjs` for the desktop app.

## Tests

- vitest, files next to the code (`*.test.ts`).
- Go through `src/test/harness.ts`: it builds the real app on an in-memory database with pollers off,
  calls it with `app.request` (no port) and collects published events.
- MCP tests use the SDK client against the same app (`mcp/mcp.test.ts`).
- No network: fake `gh`, T3 and the CLI.
