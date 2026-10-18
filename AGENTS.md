| The hidden social network: its tools, feed and art sandbox | [docs/features/social.md](docs/features/social.md) |

# AGENTS.md

Local kanban board for coding agents: agents add tasks to a backlog, write plans and move them along over MCP; the web UI
updates live. User-facing docs are the root `README.md` and the guides in `docs/guide/`; docs for changing
the code are the rest of `docs/` (start at [docs/README.md](docs/README.md)).

## Must

- **Never hard-code the product name**, env var prefix, data dir or storage keys. The name lives only in
  the root `package.json` (`name`, `displayName`); code reads it through `BRAND` / `brandEnv()` /
  `storageKey()` / `ACTOR_HEADER` in `packages/contracts/src/brand.ts`. Workspace packages use the
  brand-neutral `@repo/*` scope.
- **Never touch the real `~/.<name>` data dir**, in tests or by hand.
- **PR titles follow Conventional Commits**, like the commits: `feat(web): add favicon options`.
- **Don't run `pnpm dev` or `pnpm desktop` from a worktree.** They use the user's real data dir and the
  ports of the board the user runs from main (:4317 / :5317), so this branch's code and migrations would
  run on real data. Use `pnpm sandbox`, which uses a throwaway data dir and free ports; to try the
  Electron shell, `pnpm sandbox --desktop`.

## Layout

Each app has its own `AGENTS.md` with the conventions for working in it.

- `packages/contracts`: zod schemas, inferred types and pure helpers shared by server and web. Change
  the contract here first; both apps typecheck against it.
- `apps/server`: REST, SSE and MCP server ([AGENTS.md](apps/server/AGENTS.md)).
- `apps/web`: the React board ([AGENTS.md](apps/web/AGENTS.md)).
- `apps/desktop`: Electron shell that runs or attaches to the server ([AGENTS.md](apps/desktop/AGENTS.md)).
- `skills/<name>/`: the skill and `AGENTS.md` snippet we ship to agents that _use_ the board. Not used
  by the app.
- `scripts/`: repo scripts, run with plain `node`.

## Commands

```sh
pnpm sandbox        # this checkout's board on free ports with seeded data; `pnpm sandbox stop` (.claude/skills/sandbox)
pnpm sandbox --desktop   # the same, plus the Electron shell attached to it (stop closes it too)
pnpm dev            # server :4317 + Vite :5317 (main checkout only, see Must)
pnpm desktop        # pnpm dev + Electron window (main checkout only)
pnpm typecheck      # quick check while iterating
pnpm --filter @repo/server test -- src/services/tasks.test.ts   # one test file
pnpm check          # format:check, lint, typecheck, knip, docs:check, test: run before saying you're done
```

Commit hooks format, lint and check the commit message; don't bypass them. CI runs `pnpm check` on
ubuntu and windows, so run it before pushing.

## Conventions

- TypeScript strict and ESM. Server and contracts import local files with the `.ts` extension; web uses
  the `~/` alias without extensions. Use `import type` for types.
- Validate at the edges with zod schemas from contracts.
- Comments explain _why_, only where the code doesn't. Match the surrounding density.
- Lint suppressions must be targeted and give a reason:
  `// oxlint-disable-next-line rule -- reason`.
- Commits follow Conventional Commits (`feat(web): …`, `fix(server): …`, `chore: …`).

## Docs

Read the doc for the area before changing it, and update it in the same PR when behaviour changes. The
rules for docs, ADRs and templates are in [docs/README.md](docs/README.md); add new docs to its index
and to this table.

| Changing…                                                      | Read                                                                                |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Anything cross-cutting: request flow, tables, env vars, guard  | [docs/architecture.md](docs/architecture.md) and [docs/decisions/](docs/decisions/) |
| Statuses, closing, archiving, deleting, numbering              | [docs/features/task-lifecycle.md](docs/features/task-lifecycle.md)                  |
| Plans, steps, the current step, Markdown plans                 | [docs/features/plans.md](docs/features/plans.md)                                    |
| Epics: grouping tasks, derived status, bands, epic tools       | [docs/features/epics.md](docs/features/epics.md)                                    |
| Blocks / blocked by, the card lock, dependency lines           | [docs/features/relations.md](docs/features/relations.md)                            |
| MCP tools, their descriptions or results; the shipped skill    | [docs/features/mcp.md](docs/features/mcp.md)                                        |
| Task templates: fields, placeholders, creating from one        | [docs/features/templates.md](docs/features/templates.md)                            |
| SSE, the board reducer, mutations                              | [docs/features/live-sync.md](docs/features/live-sync.md)                            |
| Labels: normalizing, colours, filters, the MCP hint            | [docs/features/labels.md](docs/features/labels.md)                                  |
| Column collapse, panel sections, card links, the settings page | [docs/features/board-layout.md](docs/features/board-layout.md)                      |
| Themes, contrast, glass, panel animations, fonts               | [docs/features/appearance.md](docs/features/appearance.md)                          |
| Board filters, URL params, saved views                         | [docs/features/saved-views.md](docs/features/saved-views.md)                        |
| PR links, the GitHub poller and merging                        | [docs/features/github-prs.md](docs/features/github-prs.md)                          |
| Creating tasks from Jira or GitHub issue URLs                  | [docs/features/issue-import.md](docs/features/issue-import.md)                      |
| The hand-off menu (copy prompt, new T3 thread), T3 RPC client  | [docs/features/agent-handoff.md](docs/features/agent-handoff.md)                    |
| Agent session links, their status, the terminal launcher       | [docs/features/agent-sessions.md](docs/features/agent-sessions.md), ADRs 0009, 0010 |
| Local review rounds, findings, the board reviewer              | [docs/features/local-review.md](docs/features/local-review.md)                      |
| The Electron shell                                             | [docs/features/desktop.md](docs/features/desktop.md)                                |
| Notifications: the inbox, pop-ups, badges, their producers     | [docs/features/notifications.md](docs/features/notifications.md)                    |
| Backup, restore, the dump format, the git backup               | [docs/features/backup.md](docs/features/backup.md)                                  |
| Pasted images: upload, storage, the pill, backups              | [docs/features/attachments.md](docs/features/attachments.md)                        |
| The rich Markdown editor, its round trip and fallback          | [docs/features/rich-editor.md](docs/features/rich-editor.md)                        |
| Autopilot: automations, scopes, limits, runs, pause            | [docs/features/autopilot.md](docs/features/autopilot.md) and ADR 0008               |
| Suggested changes to prompts and skills, accepting them        | [docs/features/suggestions.md](docs/features/suggestions.md)                        |
| Stats: the weekly trends API, its series and their definitions | [docs/features/stats.md](docs/features/stats.md)                                    |
| What users can do, how to install, configure or connect agents | [docs/guide/](docs/guide/) (user-facing) and `README.md`                            |
| UI styles and primitives                                       | [docs/reference/style.md](docs/reference/style.md)                                  |

## What agents are told

Agents that use the board learn it only from what we ship them, not from these docs. When a change
alters what an agent can do or should do (a tool, its arguments or results, a status, the plan gate,
links, labels, review), update every place that tells them, in the same PR:

| Text                                        | Where                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| Server instructions (sent on connect)       | `INSTRUCTIONS` in `apps/server/src/mcp/server.ts`                           |
| Tool descriptions and argument descriptions | `apps/server/src/mcp/tools/*.ts`, shared fields in `mcp/shared.ts`          |
| Hints in results (Missing links/labels)     | `apps/server/src/mcp/format.ts`; review loop text in `tools/reviews.ts`     |
| The hand-off prompt                         | `taskHandoffPrompt` in `packages/contracts/src/handoff.ts`                  |
| The shipped skill and snippet               | `skills/aboard/SKILL.md` and `AGENTS-snippet.md`, then `pnpm skill:embed`   |
| The review skill                            | `skills/aboard-review/SKILL.md` and `BUILTIN_REVIEW_SKILL_BODY`             |
| The planning skill and its prompt           | `skills/aboard-plan/SKILL.md`, `BUILTIN_PLAN_SKILL_BODY`, `planTasksPrompt` |

- Keep them consistent: a tool renamed in one place and not another sends agents to a tool that doesn't
  exist. No test ties the skill to the tools; `skills.test.ts` only checks the review and planning skills against
  their built-in bodies, and `skills/aboard/` against the copy embedded in `packages/contracts/src/boardSkill.ts`,
  which the board installs into users' skill folders (`pnpm skill:embed` regenerates it).
- If nothing an agent sees changes (UI-only work, refactors), none of these need touching.
- How to write them is in [docs/features/mcp.md](docs/features/mcp.md#writing-tool-descriptions).

## Tracking work on the board

If the `aboard` MCP server is connected, track work in this repo on it; the server explains the
workflow when it connects.
