# AGENTS.md

Local kanban board for coding agents: agents log ideas, write plans and move tasks over MCP; the web UI
updates live. User-facing docs are in `README.md`, design notes in `docs/`.

## Product name

The name lives only in the root `package.json` (`name`, `displayName`). Code reads it through
`BRAND` / `brandEnv()` / `storageKey()` / `ACTOR_HEADER` in `packages/contracts/src/brand.ts`. Never
hard-code the product name, env var prefix, data dir or storage keys. Workspace packages use the
brand-neutral `@repo/*` scope. Keep the name out of prose docs where a neutral phrase works.

## Layout

- `packages/contracts`: zod schemas and inferred types shared by server and web, plus pure helpers.
  Change the contract here first; both apps typecheck against it.
- `apps/server`: Hono on Node 24, `node:sqlite`, REST + SSE + MCP (`/mcp`), GitHub/T3 integrations.
  - `services/*` holds all business logic. REST routes (`http/routes`), MCP tools (`mcp/tools`) and
    pollers stay thin and call services.
  - Every mutation runs in a transaction, appends a `task_events` row and publishes a `BoardEvent`.
  - Schema changes are new numbered files in `db/migrations/`; never edit a shipped migration.
- `apps/web`: React 19, Vite, Tailwind v4, Base UI, TanStack Query + zustand. Server state is in the
  Query cache, kept fresh by SSE (`state/boardReducer.ts`). UI-only state is in `state/ui.ts`.
  - `components/ui/*` are primitives ported from T3 Code (MIT, see `NOTICE`). Keep diffs from upstream
    small. `docs/STYLE_REFERENCE.md` maps where the styles come from.
  - Pure logic sits in `*.logic.ts` files next to the components, with tests beside it.
- `apps/desktop`: Electron shell. The main process (`src/main.ts`) only manages the window, tray and
  server lifecycle. It attaches to a server already answering `/api/health` with our id, otherwise it runs
  the esbuild server bundle (`apps/server/dist/server.mjs`, `pnpm --filter @repo/server bundle`) in a
  `utilityProcess`. That process talks back over `process.parentPort` (`ready` / `shutdown`) in
  `apps/server/src/main.ts`. Packaging config is code (`scripts/package.ts`) so names derive from `BRAND`.
  The window is frameless with native controls painted over the page (T3 Code's `titleBarOverlay`); the
  web app reads `navigator.windowControlsOverlay` (`.wco` class) and reports its theme through the
  preload's `window.desktopBridge` (`DesktopBridge` in contracts). Top bars use `.drag-region`.
- `skills/<name>/`: the skill and `AGENTS.md` snippet we ship to agents that _use_ the board. These
  files are not used by the app.

## Commands

```sh
pnpm dev            # server :4317 + Vite :5317
pnpm desktop        # pnpm dev + Electron window (attaches to the dev server)
pnpm desktop:package  # Windows installer in apps/desktop/release/
pnpm sandbox        # this checkout's board on free ports with seeded data; `pnpm sandbox stop` (.claude/skills/sandbox)
pnpm check          # format:check, lint, typecheck, knip, test: run before saying you're done
pnpm format         # oxfmt (write)
pnpm lint:fix       # oxlint autofix
pnpm --filter @repo/server test -- src/services/tasks.test.ts   # one file
```

Git hooks (lefthook) format and lint staged files on commit, check the commit message, and run
typecheck, test and knip on push. Don't bypass them; fix the cause.

## Conventions

- TypeScript strict and ESM. Server and contracts import local files with the `.ts` extension; web uses
  the `~/` alias without extensions. Use `import type` for types.
- Validate at the edges with zod schemas from contracts. Services throw `AppError` codes (`errors.ts`).
- Server binds to `127.0.0.1` only. Keep the localhost/Origin guard intact.
- Tests use vitest. Server tests go through `test/harness.ts`, which uses a temp data dir and
  `app.request`. Web tests cover logic only, with no DOM rendering. Never touch the real `~/.<name>` dir.
- Comments explain _why_, only where the code doesn't. Match the surrounding density.
- Lint suppressions must be targeted and give a reason:
  `// oxlint-disable-next-line rule -- reason`.
- Commits follow Conventional Commits (`feat(web): …`, `fix(server): …`, `chore: …`).
- PR titles follow Conventional Commits, like the commits: `feat(web): add favicon options`.

## Tracking work on the board (dogfooding)

If the `aboard` MCP server is connected, use it for work in this repo. Follow the workflow in
`skills/aboard/SKILL.md`: orient with `board_overview`, `get_task` before resuming, plan before
implementing, keep steps current, and finish with an `add_note` handover.
