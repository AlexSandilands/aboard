# AGENTS.md

Local kanban board for coding agents: agents log ideas, write plans and move tasks over MCP; the web UI
updates live. User-facing docs are in `README.md`; docs for changing the code are in `docs/` (start at
[docs/README.md](docs/README.md)).

## Product name

The name lives only in the root `package.json` (`name`, `displayName`). Code reads it through
`BRAND` / `brandEnv()` / `storageKey()` / `ACTOR_HEADER` in `packages/contracts/src/brand.ts`. Never
hard-code the product name, env var prefix, data dir or storage keys. Workspace packages use the
brand-neutral `@repo/*` scope. Keep the name out of prose docs where a neutral phrase works.

## Layout

Each app has its own `AGENTS.md` with the conventions for working in it.

- `packages/contracts`: zod schemas and inferred types shared by server and web, plus pure helpers.
  Change the contract here first; both apps typecheck against it.
- `apps/server`: Hono on Node 24, `node:sqlite`, REST + SSE + MCP (`/mcp`), GitHub/T3 integrations.
  See [apps/server/AGENTS.md](apps/server/AGENTS.md).
- `apps/web`: React 19, Vite, Tailwind v4, Base UI, TanStack Query + zustand.
  See [apps/web/AGENTS.md](apps/web/AGENTS.md).
- `apps/desktop`: Electron shell that runs or attaches to the server.
  See [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md).
- `skills/<name>/`: the skill and `AGENTS.md` snippet we ship to agents that _use_ the board. These
  files are not used by the app.
- `scripts/`: repo scripts, run with plain `node` (`check-doc-links.ts`).

## Commands

```sh
pnpm dev            # server :4317 + Vite :5317
pnpm desktop        # pnpm dev + Electron window (attaches to the dev server)
pnpm desktop:package  # Windows installer in apps/desktop/release/
pnpm sandbox        # this checkout's board on free ports with seeded data; `pnpm sandbox stop` (.claude/skills/sandbox)
pnpm check          # format:check, lint, typecheck, knip, docs:check, test: run before saying you're done
pnpm format         # oxfmt (write)
pnpm lint:fix       # oxlint autofix
pnpm docs:check     # broken links in Markdown and docs/ paths in code
pnpm --filter @repo/server test -- src/services/tasks.test.ts   # one file
```

Git hooks (lefthook) format and lint staged files and check the commit message on commit. There is
no pre-push hook: run `pnpm check` before pushing; CI runs it on ubuntu and windows and lints every PR
commit message. Don't bypass the hooks; fix the cause.

## Conventions

- TypeScript strict and ESM. Server and contracts import local files with the `.ts` extension; web uses
  the `~/` alias without extensions. Use `import type` for types.
- Validate at the edges with zod schemas from contracts.
- Tests use vitest. Never touch the real `~/.<name>` data dir.
- Comments explain _why_, only where the code doesn't. Match the surrounding density.
- Lint suppressions must be targeted and give a reason:
  `// oxlint-disable-next-line rule -- reason`.
- Commits follow Conventional Commits (`feat(web): …`, `fix(server): …`, `chore: …`).
- PR titles follow Conventional Commits, like the commits: `feat(web): add favicon options`.

## Docs

Read the doc for the area before changing it, and update it in the same PR when behaviour changes.
The rules for what goes where are in [docs/README.md](docs/README.md).

| Changing…                                                     | Read                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Anything cross-cutting: request flow, tables, env vars, guard | [docs/architecture.md](docs/architecture.md) and [docs/decisions/](docs/decisions/) |
| Statuses, closing, archiving, deleting, numbering             | [docs/features/task-lifecycle.md](docs/features/task-lifecycle.md)                  |
| Plans, steps, the current step, Markdown plans                | [docs/features/plans.md](docs/features/plans.md)                                    |
| MCP tools, their descriptions or results; the shipped skill   | [docs/features/mcp.md](docs/features/mcp.md)                                        |
| SSE, the board reducer, mutations                             | [docs/features/live-sync.md](docs/features/live-sync.md)                            |
| Labels: normalizing, colours, filters, the MCP hint           | [docs/features/labels.md](docs/features/labels.md)                                  |
| Column collapse, panel sections, which links a card shows     | [docs/features/board-layout.md](docs/features/board-layout.md)                      |
| PR links and the `gh` poller                                  | [docs/features/github-prs.md](docs/features/github-prs.md)                          |
| The hand-off menu (copy prompt, new T3 thread), T3 RPC client | [docs/features/agent-handoff.md](docs/features/agent-handoff.md)                    |
| Local review rounds, findings, the board reviewer             | [docs/features/local-review.md](docs/features/local-review.md)                      |
| The Electron shell                                            | [docs/features/desktop.md](docs/features/desktop.md)                                |
| UI styles and primitives                                      | [docs/reference/style.md](docs/reference/style.md)                                  |

- Docs describe the code as it is now. Planned work goes on the board, not in docs.
- A new feature gets `docs/features/<name>.md` from [docs/templates/feature.md](docs/templates/feature.md).
- A decision that constrains more than one feature gets an ADR from
  [docs/templates/decision.md](docs/templates/decision.md), numbered one past the highest in
  `docs/decisions/`. Don't rewrite an accepted ADR; supersede it.
- Add new docs to the index in `docs/README.md` and to the table above.

## What agents are told

Agents that use the board learn it only from what we ship them, not from these docs. When a change
alters what an agent can do or should do (a tool, its arguments or results, a status, the plan gate,
links, labels, review), update every place that tells them, in the same PR:

| Text                                        | Where                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| Server instructions (sent on connect)       | `INSTRUCTIONS` in `apps/server/src/mcp/server.ts`                       |
| Tool descriptions and argument descriptions | `apps/server/src/mcp/tools/*.ts`, shared fields in `mcp/shared.ts`      |
| Hints in results (Missing links/labels)     | `apps/server/src/mcp/format.ts`; review loop text in `tools/reviews.ts` |
| The hand-off prompt                         | `taskHandoffPrompt` in `packages/contracts/src/handoff.ts`              |
| The shipped skill and snippet               | `skills/aboard/SKILL.md` and `skills/aboard/AGENTS-snippet.md`          |
| The review skill                            | `skills/aboard-review/SKILL.md` and `BUILTIN_REVIEW_SKILL_BODY`         |

- Keep them consistent: a tool renamed in one place and not another sends agents to a tool that doesn't
  exist. No test ties the skill to the tools; only the review skill is checked (`skills.test.ts`).
- If nothing an agent sees changes (UI-only work, refactors), none of these need touching.
- How to write them is in [docs/features/mcp.md](docs/features/mcp.md#writing-tool-descriptions).

## Tracking work on the board (dogfooding)

If the `aboard` MCP server is connected, use it for work in this repo. Follow the workflow in
`skills/aboard/SKILL.md`: orient with `board_overview`, `get_task` before resuming, plan before
implementing, keep steps current, and finish with an `add_note` handover.
