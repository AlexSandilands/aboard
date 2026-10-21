| `social_posts`    | The agents' social network: handle, kind, body, reply, private task and session refs. Pruned after 90 days, not backed up ([social](features/social.md)) |
# Architecture

A local kanban board for coding agents. One Node process holds the data and serves three surfaces: a
REST API and a live event stream for the web app, and an MCP endpoint for agents. Both surfaces call the
same services, so an agent's change reaches open browsers within a second.

```
 browser (apps/web) ──REST /api/*──┐                     ┌── task_events row
        ▲                          ├─► services/* ─► SQLite transaction ─┤
        └──SSE /events◄── bus ◄────┤                     └── commit ─► BoardEvents ─► bus
 agents ──MCP POST /mcp────────────┘
 pollers (GitHub, T3 Code, review watchdog, Autopilot) ──► services/*
```

## Packages

| Package              | Holds                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts` | zod schemas and inferred types shared by server and web, plus pure helpers (`derive.ts`, `planMarkdown.ts`, `links.ts`, `brand.ts`). Exported as TS source. |
| `apps/server`        | Hono on Node 24: REST, SSE, MCP, services, `node:sqlite`, and the GitHub, T3 Code and review integrations                         |
| `apps/web`           | React 19 + Vite. Server state in the TanStack Query cache, kept fresh by SSE; UI-only state in zustand                            |
| `apps/desktop`       | Electron shell that runs or attaches to the server and shows the web app. See [features/desktop.md](features/desktop.md)          |
| `skills/`            | The skills and `AGENTS.md` snippet shipped to agents that use the board. Not loaded by the app, except that a test keeps `skills/aboard-review/SKILL.md` identical to the built-in review skill and `skills/aboard/` and `skills/aboard-automations/` identical to the texts embedded in contracts. |

The product name, id and version come only from the root `package.json`, through `BRAND` in
`packages/contracts/src/brand.ts`. Env vars (`brandEnv`), browser storage keys (`storageKey`), the
data dir and the REST actor header (`ACTOR_HEADER`) are all derived from it.

## Processes and ports

- `pnpm dev`: the server on **4317** (`tsx watch`, which restarts on edits but not on a file merely being read, unlike `node --watch` on
  NTFS) and Vite on **5317**. Vite proxies
  `/api`, `/mcp` and `/events` to the server.
- `pnpm start`: builds the web app; the server serves `apps/web/dist` on 4317 after its API, SSE and MCP
  routes, with an `index.html` fallback for client routes.
- Desktop: the Electron main process attaches to a server already on the port, or runs the esbuild
  bundle `apps/server/dist/server.mjs` in a `utilityProcess`.

The server always binds `127.0.0.1`. Boot order is `apps/server/src/main.ts` → `startServer`
(`server.ts`) → `createContext` (`context.ts`: database, bus, integrations, services) → `createApp`
(`app.ts`: guard, `/api/health`, SSE, REST, MCP). The pollers start only when enabled.

## Configuration

Read once in `apps/server/src/config.ts`. Names are built with `brandEnv(KEY)`, which upper-cases the
brand id and adds the key (`brandEnv("PORT")` is `<ID>_PORT`).

| Variable                  | Default                     | Meaning                                                            |
| ------------------------- | --------------------------- | ------------------------------------------------------------------ |
| `brandEnv("HOME")`        | `~/.<id>`                   | Data dir. Holds `data.sqlite` (plus its WAL files), `server.json` while a server runs, and `worktrees/` for Autopilot's headless runs |
| `brandEnv("PORT")`        | `4317`                      | Listen port. Also read by Vite's proxy and the desktop shell       |
| `brandEnv("WEB_PORT")`    | `5317`                      | Vite's port. The guard allows it as an Origin                      |
| `brandEnv("TOKEN")`       | none                        | Optional bearer token for `/api/*`, `/mcp` and `/events`           |
| `brandEnv("WEB_DIST")`    | `apps/web/dist`             | Built web app to serve                                             |
| `brandEnv("POLLERS")`     | on                          | `0` turns off the background pollers               |
| `brandEnv("DEMO")`        | off                         | `1` registers `/api/demo` (`http/routes/demo.ts`), which sets PR checks and pretend Autopilot runs for recording the README demo. Only the isolated sandbox sets it |
| `brandEnv("DEV_URL")`     | none                        | Desktop only: load this URL (Vite) and attach instead of spawning  |
| `brandEnv("USER_HOME")`   | the OS home folder          | Where global skills are read and installed (`.claude/skills`, …). The sandbox points it at its own folder, and then the board skills ignore `CLAUDE_CONFIG_DIR`, `COPILOT_HOME` and `CODEX_HOME` |
| `T3CODE_HOME`             | `~/.t3`                     | Where to find T3 Code's runtime file                               |
| `CLAUDE_CONFIG_DIR`       | `~/.claude`                 | Where Claude Code keeps running sessions, for session status        |
| `COPILOT_HOME`            | `~/.copilot`                | The same for Copilot CLI                                            |
| `CODEX_HOME`              | `~/.codex`                  | Codex's folder. The board skills go in its `skills/`, as it does under `CLAUDE_CONFIG_DIR` and `COPILOT_HOME` |

Settings changed in the UI (T3 token, polling, review options) live in the `settings` table, not in env
vars. See `apps/server/src/services/settings.ts`. Backups and restore: [features/backup.md](features/backup.md).

## The guard

`apps/server/src/http/guard.ts` runs before every route ([ADR 0003](decisions/0003-localhost-guard.md)):

- **Host** must be `127.0.0.1`, `localhost` or `[::1]` (any port). This stops DNS rebinding.
- **Origin**, when present, must be http(s) on a local host and on the server's port or Vite's (`WEB_PORT`, 5317).
  Requests without an Origin (agents, curl) pass.
- **Token**, when configured: `/api/*` (except `/api/health`), `/mcp` and `/events` need
  `Authorization: Bearer <token>` or a `token` query parameter (EventSource can't send headers). Static
  files don't.

## How a change flows

Every mutation, whoever makes it, takes the same path ([ADR 0001](decisions/0001-service-layer.md)):

1. **Edge.** A REST route (`http/routes/*.ts`) parses input with a contracts schema inside `handle`; an
   MCP tool (`mcp/tools/*.ts`) does the same inside `run`. A poller calls services directly.
2. **Service.** `services/*.ts` holds the rules and calls `core.write(fn)` (`services/core.ts`).
3. **Transaction.** `write` runs `fn` in `BEGIN IMMEDIATE … COMMIT` (`transaction` in
   `db/database.ts`). Nested writes join the outer one. `fn` gets `Effects`: `fx.log(taskId, actor,
type, payload)` appends a `task_events` row (the activity log), and `fx.task(id)` / `fx.project(id)`
   / `fx.detail(id)` mark what changed.
4. **Publish.** After COMMIT, `flush` turns the marks into `BoardEvent`s and publishes them on the
   in-process `EventBus` (`bus.ts`). A failed transaction publishes nothing.
5. **Stream.** `GET /events` (`sse.ts`) sends every event to every connected browser, which patches its
   Query cache ([ADR 0005](decisions/0005-sse-without-replay.md), [live sync](features/live-sync.md)).

Errors are `AppError`s (`errors.ts`) with a code: `NOT_FOUND` 404, `VALIDATION` 400, `CONFLICT` 409,
`PLAN_REQUIRED` 422, `INTERNAL` 500. REST returns `{error: {code, message, details}}`; MCP returns
`CODE: message` as an error result, sometimes with a hint.

`BoardEvent` (`packages/contracts/src/schemas.ts`) is `project.upserted`, `project.deleted`,
`task.upserted` (a full `TaskSummary`), `task.deleted`, `task.detail_changed`, `integrations.changed`,
`labels.colors_changed`, `autopilot.changed`, `notification.created`, `notifications.changed` and `suggestions.changed`. Every `task.upserted` comes with a `task.detail_changed`.

## Data model

SQLite through `node:sqlite` ([ADR 0002](decisions/0002-node-sqlite.md)), with WAL, foreign keys on and
a 5-second busy timeout. Migrations are `apps/server/src/db/migrations/NNN_name.sql`, applied in name
order at startup, each in its own transaction, and recorded in `migrations`. One that needs code (such as
parsing URLs) is a function in `db/codeMigrations.ts` under the next number instead, and runs in the same order. Never edit a shipped one;
add the next number. A migration that rebuilds a table (SQLite's create, copy, drop, rename) starts with
`-- migrate: foreign_keys off`: dropping the old table with foreign keys on would cascade-delete its
children. The runner turns them off around that file and runs `foreign_key_check` before committing. Repos in `db/repos/*.ts` are thin typed SQL over a prepared-statement cache, with no
ORM.

| Table             | Holds                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `projects`        | A swimlane: title, `workspace_root` and its normalized `workspace_key` (unique), icon, T3 project id, position, archive, review skill |
| `tasks`           | `number` (the `#42`), project, title, description, `plan_context`, status, position, archive, resolution and `resolved_by_task_id`, `auto_review` override, `auto_merge` ([merge_task_pr](features/github-prs.md#merge_task_pr)), `priority` ([board-layout](features/board-layout.md#the-priority-lane)), `suggested_tier` and `suggested_reason`, `kind` (`task` or `epic`) and `parent_id` (the task's epic, [epics](features/epics.md)) |
| `plan_phases`     | Ordered phases of a task's plan                                                                                               |
| `plan_steps`      | Ordered steps: status, notes, `started_at`, `completed_at`                                                                    |
| `task_links`      | PR, ticket ([ticket systems](features/ticket-systems.md)), GitHub issue, T3 thread, agent session or URL links, with a parsed `ref_json` and a poller-written `snapshot_json`. Unique per task, kind and URL |
| `task_imports`    | A task created from a ticket or a GitHub issue: source, `pending`/`failed`/`done`, error, attempts ([issue import](features/issue-import.md)) |
| `task_events`     | The activity log: actor, type, JSON payload                                                                                   |
| `task_templates`  | Starting points for new tasks, board-wide or per project; `tasks.template_id` records which one a task came from ([templates](features/templates.md)) |
| `task_relations`  | "Blocker blocks blocked" pairs, across projects; cascade on delete ([relations](features/relations.md))                       |
| `task_labels`     | A task's labels, normalized; one row per task and label ([labels](features/labels.md))                                        |
| `label_colors`    | Label colour overrides (a hue); labels without a row take a hue hashed from their name                                        |
| `task_reviews`    | Local review rounds: round, cycle, status, reviewer, summary                                                                  |
| `review_findings` | A round's findings: severity, location, status, resolution note                                                               |
| `counters`        | `task_number`, the high-water mark for task numbers                                                                           |
| `autopilot_settings` | An Autopilot automation's mode and config at one scope (board, project) ([autopilot](features/autopilot.md))               |
| `autopilot_recurring` | Recurring-task rules: project, template, schedule, flag, the cursor and the last task made ([autopilot](features/autopilot.md)) |
| `autopilot_custom` | Custom automations: name, trigger, filters, action and when it was armed ([autopilot](features/autopilot.md#custom-automations)) |
| `autopilot_runs`  | What Autopilot did or would do: automation, task, dedupe key, status, runner details, cost, error, needs attention             |
| `autopilot_digests` | Digests of what changed: period, mode, Markdown body, cost, read state. The newest 30; not backed up ([autopilot](features/autopilot.md)) |
| `suggestions`     | Agents' suggested changes to prompts and skills: target, base text and hash, proposed text, rationale, evidence, status ([suggestions](features/suggestions.md)) |
| `notifications`   | The attention inbox: kind, task, title, body, dedupe key, read state. Pruned after 30 days, not backed up ([notifications](features/notifications.md)) |
| `settings`        | Key/value JSON for app settings                                                                                               |

Positions are fractional-index strings (`fractional-indexing`), so a move rewrites one row. Deleting a
task cascades to its plan, links, labels, events and reviews. Derived values (progress, the current step,
attention, an epic's roll-up) are computed when summaries are built, never stored. The exceptions are an agent's
request for attention (`attention_*` columns on the task, [notifications](features/notifications.md#agent-requests)) and an epic's
status, derived from its tasks but stored so lists and filters treat it like any status
([ADR 0007](decisions/0007-epic-is-a-task-kind.md)).

Where the rules live: [task lifecycle](features/task-lifecycle.md), [plans](features/plans.md),
[local review](features/local-review.md), [labels](features/labels.md), [relations](features/relations.md), [issue import](features/issue-import.md),
[templates](features/templates.md).

## Integrations

All optional, all in `apps/server/src/integrations/`, started together by `createIntegrations().start()`
on independent timers:

- **GitHub:** batched GraphQL for PR links on GitHub hosts (every 20 seconds for PRs that are changing, down to
  every 30 minutes for finished ones), with the token `gh` holds,
  and merging on request ([ADR 0006](decisions/0006-github-graphql-via-gh-token.md)). See
  [github-prs.md](features/github-prs.md).
- **T3 Code:** discovery every 60 seconds from `~/.t3/userdata/server-runtime.json`, live thread status
  every 20 seconds while a browser is connected and a token is set, project import, and thread launches
  over T3's WebSocket RPC. See [agent-handoff.md](features/agent-handoff.md).
- **Issue import:** not a timer. A task created with a `sourceUrl` starts a background job (`gh`, then
  `claude -p`); imports left pending by a restart resume at startup. See
  [issue-import.md](features/issue-import.md).
- **Agent sessions:** every 20 seconds while a browser is connected and a session is linked, the status of
  linked Claude Code and Copilot CLI sessions from their own files; opening one in a terminal on
  request ([ADR 0009](decisions/0009-board-starts-local-processes.md)); and starting a new one with the user's
  prompt ([ADR 0010](decisions/0010-board-starts-new-sessions.md)). See
  [agent-sessions.md](features/agent-sessions.md).
- **Review watchdog:** every 30 seconds, for review rounds nobody ran. See
  [local-review.md](features/local-review.md).
- **Autopilot:** a rule engine in `apps/server/src/autopilot/`, passing over the board after board events and
  every 60 seconds, and acting where an automation is switched on ([ADR 0008](decisions/0008-autopilot-engine.md),
  [autopilot.md](features/autopilot.md)). Runs a restart left going are failed and retried once at startup, pollers or not.

## Testing

- Server: vitest through `apps/server/src/test/harness.ts`, which builds the real app on an in-memory
  database with pollers off and calls it with `app.request` (no port). MCP tests use the SDK client against the same app.
- Web: logic only (`*.logic.ts`, the board reducer) in a node environment, no DOM rendering.
- Contracts: the pure helpers.
- Under load (Windows, a busy CI runner, several agents on one machine) a test's time goes to starting processes, not
  to running code. So `pnpm test` runs one package at a time (`--workspace-concurrency=1`), and
  `apps/server/vitest.config.ts` gives tests 15s instead of 5s and, on Windows, uses half the cores as workers.
  A test that runs real processes (git, a shell) sets `PROCESS_TEST_TIMEOUT` from `src/test/timeouts.ts`; it only
  matters when something hangs, so don't tune it down. Build expensive fixtures once per file, not per test:
  `createGitFixture` makes the repositories once and copies them. No retries: a flaky test is a bug to fix, or a
  test that is environmental gets a commented skip.
